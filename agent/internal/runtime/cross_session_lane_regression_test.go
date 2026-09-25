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
 * Cross-session Task overlap through the REAL daemon composition (#474).
 *
 * #474 reported that a provider whose registry policy is
 * `cross-session` / maxConcurrent 2 still serialized two independent Tasks in
 * a real Room. The Runtime's own scheduler is covered by
 * concurrent_execution_test.go against a HAND-WRITTEN scoped double, and the
 * isolated lane owner is covered by isolated_lanes_test.go against a
 * HAND-WRITTEN lane double. Neither covers the composition the daemon
 * actually builds for such a provider:
 *
 *   provider registry policy
 *     -> daemon lane construction (harness.NewIsolatedACPAdapterWithCapacity)
 *       -> ResidentRuntime turn lanes (resolveTurnLanes)
 *         -> ACPAdapter.EnsureSessionForCwd / RunTurnFor
 *           -> real ACP child processes
 *
 * This regression builds exactly that composition against the scripted ACP
 * Harness in its `hold_all` mode, which parks every prompt per native session
 * and serves them CONCURRENTLY. Two independent Human Tasks are admitted the
 * way the resident event loop admits them, and the assertions are made on
 * PROVIDER-side truth (a trace file the child writes) rather than on anything
 * the Runtime believes:
 *
 *   - lane 1: A and B hold two DIFFERENT native conversations;
 *   - lane 2: those conversations live in two DIFFERENT provider processes,
 *             so the Runtime is not merely multiplexing one shared process;
 *   - lane 3: neither Task waits for the other (B is executing while A is
 *             still running), which is the exact #474 symptom;
 *   - lane 4: settling A neither cancels nor re-dispatches B.
 *
 * It deliberately does NOT assert anything about vendor model latency: the
 * provider double's "work" is a parked prompt, so a scheduler or adapter
 * serialization bug fails this test deterministically instead of depending on
 * a real model's timing.
 */

// providerTrace captures the scripted Harness's provider-side lifecycle.
type providerTrace struct {
	path string
}

func newProviderTrace(t *testing.T) *providerTrace {
	t.Helper()
	return &providerTrace{path: filepath.Join(t.TempDir(), "provider.trace")}
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

// isolatedLaneComposition builds the adapter the daemon builds for a provider
// whose registry policy is cross-session with two lanes. The provider command
// is the scripted Harness, so the composition under test is the production one
// while the "model" is deterministic.
func isolatedLaneComposition(t *testing.T, policy types.TaskExecutionPolicy) (types.HarnessAdapter, string, *providerTrace) {
	t.Helper()
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
	trace := newProviderTrace(t)
	releaseDir := t.TempDir()
	launcher := types.AgentLauncher{
		ID:          "cross-session-provider",
		DisplayName: "Cross-session provider",
		Command:     path,
		Maturity:    types.MaturityNative,
		Security:    types.SecurityTrustedRoom,
		Environment: map[string]string{
			"FAKE_MODE":               "hold_all",
			"FAKE_RELEASE_DIR":        releaseDir,
			"FAKE_TRACE":              trace.path,
			"FAKE_UNIQUE_SESSION_IDS": "1",
		},
		TaskExecution: policy,
	}
	laneCount := launcher.TaskExecution.Lanes()
	if launcher.TaskExecution.Concurrency != types.TaskExecutionCrossSession || laneCount < 2 {
		t.Fatalf("fixture policy did not resolve to a cross-session lane pair: %+v", launcher.TaskExecution)
	}
	// The daemon's own construction branch, chosen by the same policy.
	isolated, err := harness.NewIsolatedACPAdapterWithCapacity(laneCount, func(lane int) *harness.ACPAdapter {
		return harness.NewACPAdapter(launcher, t.TempDir(), harness.AdapterOptions{
			TurnTimeoutMs: 120_000,
			CancelGraceMs: 500,
		})
	})
	if err != nil {
		t.Fatalf("build isolated adapter: %v", err)
	}
	return isolated, releaseDir, trace
}

// TestCrossSessionPolicyOverlapsIndependentTasksThroughIsolatedLanes is the
// #474 regression: the production composition must actually overlap two
// independent Task scopes, in two provider processes, before either settles.
func TestCrossSessionPolicyOverlapsIndependentTasksThroughIsolatedLanes(t *testing.T) {
	policy := types.TaskExecutionPolicy{
		Probe:         types.TaskExecutionProbeVerifiedCrossSession,
		Concurrency:   types.TaskExecutionCrossSession,
		MaxConcurrent: 2,
	}
	adapter, releaseDir, trace := isolatedLaneComposition(t, policy)
	t.Cleanup(func() { _ = adapter.Close() })

	rt, client := newLaneRuntime(t, adapter, policy)

	// A is admitted and observed running BEFORE B is ever submitted, which is
	// the exact #474 sequence.
	startScopedTurn(rt, 60, "task:req-A", "long shell work A")
	waitFor(t, 20*time.Second, func() bool {
		return len(trace.prompts(t)) == 1
	}, "Task A to reach the provider")

	startScopedTurn(rt, 61, "task:req-B", "independent long shell work B")

	// Provider-side truth of overlap: two different native conversations are
	// executing at the same time, before either is released.
	waitFor(t, 20*time.Second, func() bool {
		prompts := trace.prompts(t)
		return len(prompts) >= 2 && prompts[0] != prompts[1]
	}, "both Tasks to execute concurrently at the provider")

	prompts := trace.prompts(t)
	if len(prompts) != 2 {
		t.Fatalf("expected exactly two provider prompts before any release, got %d: %v", len(prompts), prompts)
	}
	sessionA, sessionB := prompts[0], prompts[1]
	if sessionA == sessionB {
		t.Fatalf("#474: both Tasks were bound to ONE native conversation %q", sessionA)
	}
	// A single provider process serving two sessions would still be one lane.
	if pidA, pidB := providerPID(sessionA), providerPID(sessionB); pidA == "" || pidA == pidB {
		t.Fatalf("#474: independent Tasks shared one provider process (%q / %q)", sessionA, sessionB)
	}

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
	// B still owns its own execution lane: the Runtime reports it running.
	waitFor(t, 5*time.Second, func() bool {
		projection, ok := client.latest("req-B")
		return ok && projection.Phase == types.TaskExecutionPhaseRunning
	}, "Task B to remain the running Task after A settled")

	if err := os.WriteFile(filepath.Join(releaseDir, sessionB), []byte("go"), 0o600); err != nil {
		t.Fatalf("release %s: %v", sessionB, err)
	}
	waitFor(t, 20*time.Second, func() bool {
		return len(rt.pendingAddressedSnapshotFor("task:req-B")) == 0
	}, "Task B to settle")
}
