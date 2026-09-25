package runtime

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Cross-session Task overlap through the REAL provider topology (#474).
 *
 * #474 reported that a provider whose registry policy is `cross-session` with
 * maxConcurrent 2 still serialized two independent Tasks in a real Room. The
 * pre-existing coverage stopped short of the composition the daemon builds:
 * concurrent_execution_test.go drives the Runtime with a HAND-WRITTEN scoped
 * double, and isolated_lanes_test.go drives the lane owner with a HAND-WRITTEN
 * lane double.
 *
 * This regression asks the registry and the production factory instead of
 * restating their answers:
 *
 *   harness.ProviderByID("hermes").Launcher()   <- the real registry policy
 *     -> harness.BuildAdapter                   <- the ONE topology decision
 *       -> ResidentRuntime turn lanes           <- resolveTurnLanes
 *         -> ACPAdapter.EnsureSessionForCwd / RunTurnFor
 *           -> real ACP child processes
 *
 * Everything asserted here is provider-side truth: the adapter's own
 * DiagnosticsSnapshot (lane -> scope, session hash, provider pid, turn active)
 * and a trace file the child process writes. Nothing is asserted about vendor
 * model latency: the double's "work" is a parked prompt, so a topology or
 * serialization regression fails deterministically.
 *
 * Deliberately NOT covered: which launcher a real Room selected. The registry
 * entry's own lane count IS guarded below, so a silent downgrade to one lane
 * fails loudly rather than quietly passing.
 */

// providerTrace reads the scripted Harness's provider-side frame log.
type providerTrace struct {
	path string
}

// prompts returns every `session/prompt` the provider received, in order. Each
// entry exists only after the child process really read that frame.
func (p *providerTrace) prompts(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(p.path)
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "IN ") {
			continue
		}
		var frame struct {
			Method string `json:"method"`
			Params struct {
				SessionID string `json:"sessionId"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "IN ")), &frame) != nil || frame.Method != "session/prompt" {
			continue
		}
		out = append(out, frame.Params.SessionID)
	}
	return out
}

// providerPID reads the process id the scripted Harness embeds in its
// process-unique session ids (`session-<pid>-<n>`). Two conversations in one
// process would be a shared-process multiplex, not two lanes.
func providerPID(sessionID string) string {
	parts := strings.Split(sessionID, "-")
	if len(parts) < 3 {
		return ""
	}
	return parts[1]
}

// hermesPolicyThroughProductionFactory builds the adapter the DAEMON builds for
// Hermes: the real registry policy in, harness.BuildAdapter out. The provider
// command is swapped for the scripted Harness so the topology under test is
// production while the "model" is deterministic.
func hermesPolicyThroughProductionFactory(t *testing.T) (types.HarnessAdapter, types.TaskExecutionPolicy, string, *providerTrace) {
	t.Helper()
	provider, err := harness.ProviderByID("hermes")
	if err != nil {
		t.Fatalf("hermes provider: %v", err)
	}
	launcher := provider.Launcher()
	policy := launcher.TaskExecution
	if policy.Concurrency != types.TaskExecutionCrossSession || policy.Lanes() != 2 {
		t.Fatalf("#474: Hermes registry policy no longer advertises two cross-session lanes: %+v", policy)
	}

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate runtime test source")
	}
	agentDir := filepath.Clean(filepath.Join(filepath.Dir(source), "..", ".."))
	path := filepath.Join(t.TempDir(), "fakeagent")
	build := exec.Command("go", "build", "-o", path, "./internal/harness/testdata/fakeagent")
	build.Dir = agentDir
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake ACP Harness: %v\n%s", err, output)
	}
	trace := &providerTrace{path: filepath.Join(t.TempDir(), "provider.trace")}
	releaseDir := t.TempDir()
	launcher.Command = path
	launcher.Args = nil
	launcher.Environment = map[string]string{
		"FAKE_MODE":               "hold_all",
		"FAKE_RELEASE_DIR":        releaseDir,
		"FAKE_TRACE":              trace.path,
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}

	adapter, err := harness.BuildAdapter(launcher, t.TempDir(), harness.AdapterOptions{
		TurnTimeoutMs: 120_000,
		CancelGraceMs: 500,
	})
	if err != nil {
		t.Fatalf("BuildAdapter: %v", err)
	}
	diagnostics, ok := adapter.(types.HarnessDiagnostics)
	if !ok {
		t.Fatalf("#474: production factory produced %T without a diagnostics snapshot", adapter)
	}
	// The topology decision itself: the registry policy must have become real
	// provider-process lanes, not one serial adapter.
	if capacity := diagnostics.DiagnosticsSnapshot().Capacity; capacity != policy.Lanes() {
		t.Fatalf("#474: registry policy advertises %d lanes but the production factory built %d", policy.Lanes(), capacity)
	}
	return adapter, policy, releaseDir, trace
}

// TestCrossSessionPolicyOverlapsIndependentTasksThroughIsolatedLanes is the
// #474 regression: the REAL registry policy, through the REAL daemon factory,
// must overlap two independent Task scopes in two provider processes before
// either settles.
func TestCrossSessionPolicyOverlapsIndependentTasksThroughIsolatedLanes(t *testing.T) {
	adapter, policy, releaseDir, trace := hermesPolicyThroughProductionFactory(t)
	t.Cleanup(func() { _ = adapter.Close() })
	diagnostics := adapter.(types.HarnessDiagnostics)

	rt, client := newLaneRuntime(t, adapter, policy)

	// A is admitted and observed running BEFORE B is ever submitted, which is
	// the exact #474 sequence.
	startScopedTurn(rt, 60, "task:req-A", "long shell work A")
	waitFor(t, 20*time.Second, func() bool {
		return len(trace.prompts(t)) == 1
	}, "Task A to reach the provider")

	startScopedTurn(rt, 61, "task:req-B", "independent long shell work B")

	// Provider-side truth of overlap: the adapter itself reports TWO lanes
	// executing a turn, for two DIFFERENT scopes, before either is released.
	waitFor(t, 20*time.Second, func() bool {
		active := map[string]int{}
		for _, lane := range diagnostics.DiagnosticsSnapshot().Lanes {
			if lane.TurnActive {
				active[lane.Scope]++
			}
		}
		return active["task:req-A"] == 1 && active["task:req-B"] == 1
	}, "both Tasks to execute concurrently in their own lane")

	snapshot := diagnostics.DiagnosticsSnapshot()
	lanes := map[string]types.HarnessLaneDiagnostic{}
	for _, lane := range snapshot.Lanes {
		if lane.TurnActive {
			lanes[lane.Scope] = lane
		}
	}
	laneA, laneB := lanes["task:req-A"], lanes["task:req-B"]
	if laneA.Lane == laneB.Lane {
		t.Fatalf("#474: both Tasks executed in one lane: %+v", snapshot.Lanes)
	}
	if laneA.SessionHash == "" || laneA.SessionHash == laneB.SessionHash {
		t.Fatalf("#474: both Tasks were bound to ONE native conversation: %+v", snapshot.Lanes)
	}
	if laneA.ProviderPID <= 0 || laneA.ProviderPID == laneB.ProviderPID {
		t.Fatalf("#474: independent Tasks shared one provider process: %+v", snapshot.Lanes)
	}

	// The same fact from the child processes themselves.
	prompts := trace.prompts(t)
	if len(prompts) != 2 {
		t.Fatalf("expected exactly two provider prompts before any release, got %d: %v", len(prompts), prompts)
	}
	if prompts[0] == prompts[1] {
		t.Fatalf("#474: both Tasks were bound to ONE native conversation %q", prompts[0])
	}
	if pidA, pidB := providerPID(prompts[0]), providerPID(prompts[1]); pidA == "" || pidA == pidB {
		t.Fatalf("#474: independent Tasks shared one provider process (%q / %q)", prompts[0], prompts[1])
	}
	sessionA, sessionB := prompts[0], prompts[1]

	// Settling A must not settle, cancel, or re-dispatch B.
	if err := os.WriteFile(filepath.Join(releaseDir, sessionA), []byte("go"), 0o600); err != nil {
		t.Fatalf("release %s: %v", sessionA, err)
	}
	waitFor(t, 20*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshotFor("task:req-A")) == 0
	}, "Task A to settle")
	if got := len(rt.pendingAddressedSnapshotFor("task:req-B")); got == 0 {
		t.Fatal("#474: Task B settled when only Task A was released")
	}
	counts := map[string]int{}
	for _, sessionID := range trace.prompts(t) {
		counts[sessionID]++
	}
	if counts[sessionB] != 1 {
		t.Fatalf("Task B was re-dispatched or lost while A settled: %v", counts)
	}
	// B still owns its own execution lane: the Runtime reports it running and
	// the adapter still reports a live provider turn for it.
	waitFor(t, 5*time.Second, func() bool {
		projection, ok := client.latest("req-B")
		if !ok || projection.Phase != types.TaskExecutionPhaseRunning {
			return false
		}
		for _, lane := range diagnostics.DiagnosticsSnapshot().Lanes {
			if lane.Scope == "task:req-B" && lane.TurnActive {
				return true
			}
		}
		return false
	}, "Task B to remain the running Task after A settled")

	if err := os.WriteFile(filepath.Join(releaseDir, sessionB), []byte("go"), 0o600); err != nil {
		t.Fatalf("release %s: %v", sessionB, err)
	}
	waitFor(t, 20*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshotFor("task:req-B")) == 0
	}, "Task B to settle")
}
