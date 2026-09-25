package harness

import (
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * The ONE launcher-policy -> adapter-topology decision (#474).
 *
 * daemon.prepareRuntime calls BuildAdapter, and so do the cross-session
 * regressions. These tests pin the decision itself so neither caller can drift:
 * a launcher whose registry policy earns multiple lanes gets that many isolated
 * provider-process owners, and every other policy keeps the serial adapter.
 */

func factoryLauncher(policy types.TaskExecutionPolicy) types.AgentLauncher {
	return types.AgentLauncher{
		ID:            "factory-test",
		DisplayName:   "Factory test",
		Command:       "hermes",
		Args:          []string{"acp"},
		Maturity:      types.MaturityNative,
		Security:      types.SecurityTrustedRoom,
		TaskExecution: policy,
	}
}

func TestBuildAdapterMaterializesTheRegisteredLaneCount(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		policy     types.TaskExecutionPolicy
		wantLanes  int
		wantIsolat bool
	}{
		{
			name: "cross-session with four lanes",
			policy: types.TaskExecutionPolicy{
				Concurrency:   types.TaskExecutionCrossSession,
				MaxConcurrent: 4,
			},
			wantLanes:  4,
			wantIsolat: true,
		},
		{
			name: "cross-session with two lanes",
			policy: types.TaskExecutionPolicy{
				Concurrency:   types.TaskExecutionCrossSession,
				MaxConcurrent: 2,
			},
			wantLanes:  2,
			wantIsolat: true,
		},
		{
			// A cross-session claim of one lane is not worth a lane owner: the
			// serial adapter is exactly equivalent and cheaper.
			name: "cross-session with one lane stays serial",
			policy: types.TaskExecutionPolicy{
				Concurrency:   types.TaskExecutionCrossSession,
				MaxConcurrent: 1,
			},
			wantLanes: 1,
		},
		{
			// The fail-safe default, and the only policy a provider that never
			// opted in can express.
			name:      "serial stays serial",
			policy:    types.TaskExecutionPolicy{Concurrency: types.TaskExecutionSerial, MaxConcurrent: 8},
			wantLanes: 1,
		},
		{
			name:      "zero value stays serial",
			policy:    types.TaskExecutionPolicy{},
			wantLanes: 1,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			adapter, err := BuildAdapter(factoryLauncher(testCase.policy), t.TempDir(), AdapterOptions{})
			if err != nil {
				t.Fatalf("BuildAdapter: %v", err)
			}
			t.Cleanup(func() { _ = adapter.Close() })

			snapshot := adapter.(types.HarnessDiagnostics).DiagnosticsSnapshot()
			if snapshot.Capacity != testCase.wantLanes {
				t.Fatalf("capacity = %d, want %d (policy %+v)", snapshot.Capacity, testCase.wantLanes, testCase.policy)
			}
			if len(snapshot.Lanes) != testCase.wantLanes {
				t.Fatalf("lane snapshots = %d, want %d", len(snapshot.Lanes), testCase.wantLanes)
			}
			_, isIsolated := adapter.(*IsolatedACPAdapter)
			if isIsolated != testCase.wantIsolat {
				t.Fatalf("isolated lane owner = %v, want %v", isIsolated, testCase.wantIsolat)
			}
			// Nothing is started eagerly: a lane materializes only when a scope
			// needs a session, so building an adapter is free.
			if snapshot.Materialized != 0 {
				t.Fatalf("BuildAdapter started %d provider process(es) eagerly", snapshot.Materialized)
			}
		})
	}
}

// TestBuildAdapterTagsOnlyMultiLaneDiagnostics pins the lane attribution the
// local support surface depends on: every event of a multi-lane build names the
// lane that emitted it, and a single-lane build never grows a lane key it
// cannot attribute truthfully.
func TestBuildAdapterTagsOnlyMultiLaneDiagnostics(t *testing.T) {
	policy := types.TaskExecutionPolicy{
		Concurrency:   types.TaskExecutionCrossSession,
		MaxConcurrent: 2,
	}
	var (
		launcher   = factoryLauncher(policy)
		workspace  = t.TempDir()
		releaseDir = t.TempDir()
	)
	launcher.Command = fakeAgentPath
	launcher.Args = nil
	launcher.Environment = map[string]string{
		"FAKE_MODE":               "hold_all",
		"FAKE_RELEASE_DIR":        releaseDir,
		"FAKE_UNIQUE_SESSION_IDS": "1",
	}

	type observed struct {
		event string
		lane  string
	}
	var events []observed
	adapter, err := BuildAdapter(launcher, workspace, AdapterOptions{
		TurnTimeoutMs:   30_000,
		LaneDiagnostics: true,
		DiagnosticSink: func(event string, details map[string]string) {
			events = append(events, observed{event: event, lane: details["lane"]})
		},
	})
	if err != nil {
		t.Fatalf("BuildAdapter: %v", err)
	}
	t.Cleanup(func() { _ = adapter.Close() })

	scoped := adapter.(types.ScopedHarnessAdapter)
	for _, scope := range []string{"task:req-A", "task:req-B"} {
		if err := scoped.EnsureSessionFor(scope); err != nil {
			t.Fatalf("EnsureSessionFor(%s): %v", scope, err)
		}
	}
	if len(events) == 0 {
		t.Fatal("multi-lane build emitted no lane-tagged diagnostics")
	}
	seen := map[string]bool{}
	for _, entry := range events {
		if entry.lane != "0" && entry.lane != "1" {
			t.Fatalf("diagnostic %q carried no truthful lane: %+v", entry.event, entry)
		}
		seen[entry.lane] = true
	}
	if !seen["0"] || !seen["1"] {
		t.Fatalf("expected diagnostics from both lanes, saw %v", events)
	}

	// The serial build keeps its pre-#421 diagnostics shape.
	single, err := BuildAdapter(factoryLauncher(types.TaskExecutionPolicy{}), t.TempDir(), AdapterOptions{
		LaneDiagnostics: true,
		DiagnosticSink: func(_ string, details map[string]string) {
			if _, ok := details["lane"]; ok {
				t.Errorf("single-lane build tagged a lane: %v", details)
			}
		},
	})
	if err != nil {
		t.Fatalf("BuildAdapter(serial): %v", err)
	}
	t.Cleanup(func() { _ = single.Close() })
	if _, ok := single.(*IsolatedACPAdapter); ok {
		t.Fatal("serial policy produced an isolated lane owner")
	}
}
