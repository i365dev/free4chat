package daemon

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/runtime"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Pi existing-session handoff (#409, V1) at the daemon IPC boundary.
 *
 * The daemon is a pass-through here: it resolves the addressed local instance,
 * keeps the ACP session identity inside the request/response of the operator's
 * own CLI call, and never widens what the Runtime already enforces. These tests
 * pin that the IPC surface neither echoes the session id back nor bypasses the
 * policy-gated / one-pending-adoption rules.
 */

// handoffAdapter is a Pi-named Harness exposing the optional session
// primitives, which is exactly the local seam the Runtime handoff path uses.
type handoffAdapter struct {
	*stubAdapter
	page    harness.ACPSessionPage
	listErr error
	loadErr error
	loads   []string
	// options records the exact presence-aware list options each call used, so
	// a test can prove a global request omits cwd entirely (#409 §8).
	options []harness.ACPSessionListOptions
}

func (a *handoffAdapter) ListSessions(options harness.ACPSessionListOptions) (harness.ACPSessionPage, error) {
	a.options = append(a.options, options)
	if a.listErr != nil {
		return harness.ACPSessionPage{}, a.listErr
	}
	return a.page, nil
}

func (a *handoffAdapter) LoadSession(scope string, sessionID string, cwd string) error {
	if a.loadErr != nil {
		return a.loadErr
	}
	a.loads = append(a.loads, scope+" "+sessionID)
	return nil
}

// registerHandoffResident injects one resident backed by the given adapter,
// projecting the SAME launcher-registry support policy the daemon does. A
// resident whose launcher is not enabled never reaches the session primitives.
func registerHandoffResident(t *testing.T, d *Daemon, instanceID, adapterName string, adapter types.HarnessAdapter) {
	t.Helper()
	policy := false
	if launcher, err := harness.GetLauncher(adapterName); err == nil {
		policy = launcher.TaskSessionContinuation
	}
	rt := runtime.NewResidentRuntime(runtime.Options{
		InstanceID:              instanceID,
		RoomID:                  "handoff-room",
		Name:                    "Agent " + adapterName,
		Client:                  &recordingClient{},
		Adapter:                 adapter,
		TaskSessionContinuation: policy,
		DisposableWorkspaceRoot: WorkspacesRoot(),
	})
	t.Cleanup(rt.Stop)
	d.register(&residentInstance{
		instanceID: instanceID,
		roomID:     "handoff-room",
		runtime:    rt,
		workspace:  t.TempDir(),
	})
}

func TestHandoffAdoptDispatchStaysLocalAndSingle(t *testing.T) {
	d, _ := startDaemon(t)
	registerHandoffResident(t, d, "pi-handoff", "pi", &handoffAdapter{stubAdapter: &stubAdapter{name: "pi"}})

	adopted, err := d.Dispatch(&IpcRequest{
		Op:                 "handoff-adopt",
		InstanceID:         "pi-handoff",
		SessionID:          "native-pi-1",
		SessionCwd:         ptrString("/workspace/project"),
		HumanParticipantID: "human-1",
	})
	if err != nil {
		t.Fatalf("handoff-adopt failed: %v", err)
	}
	// The response reports the bounded local state and nothing else: the ACP
	// session identity is never echoed back through the daemon.
	want := map[string]any{"state": "armed", "armed": true, "humanParticipantId": "human-1"}
	if got, ok := adopted.(map[string]any); !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("handoff-adopt response mismatch: %#v", adopted)
	}
	encoded, err := json.Marshal(adopted)
	if err != nil {
		t.Fatalf("encode response: %v", err)
	}
	if strings.Contains(string(encoded), "native-pi-1") {
		t.Fatalf("the session id was echoed back: %s", encoded)
	}

	state, err := d.Dispatch(&IpcRequest{Op: "handoff-state", InstanceID: "pi-handoff"})
	if err != nil {
		t.Fatalf("handoff-state failed: %v", err)
	}
	if got, ok := state.(map[string]any); !ok || !reflect.DeepEqual(got, map[string]any{"armed": true, "humanParticipantId": "human-1"}) {
		t.Fatalf("handoff-state mismatch: %#v", state)
	}

	// V1 keeps at most one pending adoption; a second one is refused until the
	// operator clears it.
	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-adopt", InstanceID: "pi-handoff", SessionID: "native-pi-2"}); err == nil {
		t.Fatal("a second pending adoption was accepted")
	}
	if cleared, err := d.Dispatch(&IpcRequest{Op: "handoff-clear", InstanceID: "pi-handoff"}); err != nil {
		t.Fatalf("handoff-clear failed: %v", err)
	} else if got, ok := cleared.(map[string]any); !ok || !reflect.DeepEqual(got, map[string]any{"state": "cleared"}) {
		t.Fatalf("handoff-clear response mismatch: %#v", cleared)
	}
	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-clear", InstanceID: "pi-handoff"}); err == nil {
		t.Fatal("clearing nothing must fail clearly")
	}
	state, err = d.Dispatch(&IpcRequest{Op: "handoff-state", InstanceID: "pi-handoff"})
	if err != nil {
		t.Fatalf("handoff-state failed: %v", err)
	}
	if got, ok := state.(map[string]any); !ok || !reflect.DeepEqual(got, map[string]any{"armed": false, "humanParticipantId": ""}) {
		t.Fatalf("handoff-state after clear mismatch: %#v", state)
	}
}

func TestHandoffListDispatchReturnsBoundedDescriptors(t *testing.T) {
	d, _ := startDaemon(t)
	adapter := &handoffAdapter{
		stubAdapter: &stubAdapter{name: "pi"},
		page: harness.ACPSessionPage{
			Sessions: []harness.ACPSessionInfo{{
				SessionID: "native-pi-1",
				Cwd:       "/workspace/project",
				Title:     "Native Pi conversation",
				UpdatedAt: "2026-09-19T10:00:00Z",
			}},
			NextCursor: "",
		},
	}
	registerHandoffResident(t, d, "pi-list", "pi", adapter)

	result, err := d.Dispatch(&IpcRequest{Op: "handoff-list", InstanceID: "pi-list", SessionCwd: ptrString("/workspace/project")})
	if err != nil {
		t.Fatalf("handoff-list failed: %v", err)
	}
	body, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("encode list result: %v", err)
	}
	var decoded struct {
		Sessions []struct {
			SessionID string `json:"SessionID"`
			Cwd       string `json:"Cwd"`
		} `json:"sessions"`
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode list result: %v (%s)", err, body)
	}
	if len(decoded.Sessions) != 1 || decoded.Sessions[0].SessionID != "native-pi-1" ||
		decoded.Sessions[0].Cwd != "/workspace/project" || decoded.NextCursor != "" {
		t.Fatalf("list descriptors mismatch: %s", body)
	}

	// A discovery failure is surfaced, never silently reported as "no
	// sessions", because the operator must not mistake it for an empty store.
	adapter.listErr = errors.New("native session store is unavailable")
	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-list", InstanceID: "pi-list"}); err == nil {
		t.Fatal("a failing discovery must be surfaced")
	}
}

func TestHandoffDispatchRejectsUnknownOrUnsupportedResident(t *testing.T) {
	d, _ := startDaemon(t)
	// #409: eligibility is the launcher's centralized product policy. Hermes is
	// source-supported but not runtime-verified, so its policy is disabled and
	// its resident must be rejected even though this stub could be shaped like
	// a session-capable adapter.
	registerHandoffResident(t, d, "hermes-handoff", "hermes", &stubAdapter{name: "hermes"})

	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-adopt", InstanceID: "missing", SessionID: "native-1"}); err == nil {
		t.Fatal("an unknown instance must be rejected")
	}
	for _, op := range []string{"handoff-adopt", "handoff-list"} {
		request := &IpcRequest{Op: op, InstanceID: "hermes-handoff", SessionID: "native-1"}
		if _, err := d.Dispatch(request); err == nil || !strings.Contains(err.Error(), "not supported for this Harness") {
			t.Fatalf("%s must reject a resident whose launcher policy is disabled, got %v", op, err)
		}
	}
}

// TestHandoffListRejectsAPolicyDisabledHarness proves the launcher registry is
// the ONLY gate: the very same adapter shape is admitted for pi (enabled) and
// refused for hermes (disabled), with no Harness-name branch anywhere.
func TestHandoffListRejectsAPolicyDisabledHarness(t *testing.T) {
	d, _ := startDaemon(t)
	page := harness.ACPSessionPage{Sessions: []harness.ACPSessionInfo{{
		SessionID: "native-pi-1", Cwd: "/workspace/project", Title: "Native Pi conversation",
	}}}
	registerHandoffResident(t, d, "policy-pi", "pi", &handoffAdapter{stubAdapter: &stubAdapter{name: "pi"}, page: page})
	registerHandoffResident(t, d, "policy-hermes", "hermes", &handoffAdapter{stubAdapter: &stubAdapter{name: "hermes"}, page: page})

	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-list", InstanceID: "policy-pi"}); err != nil {
		t.Fatalf("the enabled launcher must be admitted: %v", err)
	}
	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-list", InstanceID: "policy-hermes"}); err == nil {
		t.Fatal("the disabled launcher must be refused")
	}
}

// TestHandoffDispatchDefaultsToTheSoleResident pins the operator's actual UX:
// the handoff commands take --instance only when the answer is ambiguous.
func TestHandoffDispatchDefaultsToTheSoleResident(t *testing.T) {
	d, _ := startDaemon(t)
	registerHandoffResident(t, d, "pi-only", "pi", &handoffAdapter{stubAdapter: &stubAdapter{name: "pi"}})

	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-adopt", SessionID: "native-pi-1"}); err != nil {
		t.Fatalf("a sole resident must be resolved without --instance: %v", err)
	}
	state, err := d.Dispatch(&IpcRequest{Op: "handoff-state"})
	if err != nil {
		t.Fatalf("handoff-state without --instance failed: %v", err)
	}
	if got, ok := state.(map[string]any); !ok || got["armed"] != true {
		t.Fatalf("handoff-state mismatch: %#v", state)
	}

	// Two residents make the target ambiguous: the operator must choose.
	registerHandoffResident(t, d, "pi-second", "pi", &handoffAdapter{stubAdapter: &stubAdapter{name: "pi"}})
	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-state"}); err == nil {
		t.Fatal("an ambiguous resident set must require --instance")
	}
}

// ptrString builds a presence-aware optional cwd (#409 §8): nil means "no
// cwd filter at all".
func ptrString(value string) *string {
	return &value
}

// TestHandoffListCwdIsPresenceAware is the #409 §8 fence: an omitted --cwd is
// GLOBAL discovery (the adapter omits the filter entirely), and an explicit
// --cwd is exactly that path. The invoking shell's directory is never
// substituted for either.
func TestHandoffListCwdIsPresenceAware(t *testing.T) {
	d, _ := startDaemon(t)
	adapter := &handoffAdapter{
		stubAdapter: &stubAdapter{name: "pi"},
		page: harness.ACPSessionPage{Sessions: []harness.ACPSessionInfo{{
			SessionID: "native-pi-1",
			Cwd:       "/workspace/project",
			Title:     "Native Pi conversation",
		}}},
	}
	registerHandoffResident(t, d, "pi-cwd", "pi", adapter)

	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-list", InstanceID: "pi-cwd"}); err != nil {
		t.Fatalf("global list failed: %v", err)
	}
	if len(adapter.options) != 1 || adapter.options[0].Cwd != nil {
		t.Fatalf("an omitted --cwd must send NO cwd filter: %+v", adapter.options)
	}

	if _, err := d.Dispatch(&IpcRequest{
		Op: "handoff-list", InstanceID: "pi-cwd", SessionCwd: ptrString("/private/tmp"),
	}); err != nil {
		t.Fatalf("explicit list failed: %v", err)
	}
	if len(adapter.options) != 2 || adapter.options[1].Cwd == nil || *adapter.options[1].Cwd != "/private/tmp" {
		t.Fatalf("an explicit --cwd must be sent byte-for-byte: %+v", adapter.options)
	}
}

// TestDaemonProjectsTheLauncherTaskSessionPolicy proves the Runtime receives
// the ONE product-level policy from the resolved launcher, and the daemon
// itself never decides per-Harness behavior.
func TestDaemonProjectsTheLauncherTaskSessionPolicy(t *testing.T) {
	enabled := newDaemonRuntimeForPolicy(t, "pi", true)
	enabledFeatures := enabled.CurrentRuntimeFeatures()
	if enabledFeatures == nil || !enabledFeatures.TaskSessionContinuation {
		t.Fatalf("a pi resident must advertise Task Session Continuation: %+v", enabledFeatures)
	}
	enabledCodex := newDaemonRuntimeForPolicy(t, "codex", true)
	enabledCodexFeatures := enabledCodex.CurrentRuntimeFeatures()
	if enabledCodexFeatures == nil || !enabledCodexFeatures.TaskSessionContinuation {
		t.Fatalf("a verified Codex resident must advertise Task Session Continuation: %+v", enabledCodexFeatures)
	}
	// #421 execution reconciliation is a build-level feature: it is advertised
	// for EVERY launcher, independently of the continuation policy above.
	if enabledCodexFeatures == nil || !enabledCodexFeatures.TaskExecutionReconciliation {
		t.Fatalf("execution reconciliation is not launcher-gated: %+v", enabledCodexFeatures)
	}
}

// newDaemonRuntimeForPolicy builds one resident through the SAME launcher
// registry lookup the daemon uses, so the test proves the projection rather
// than restating it.
func newDaemonRuntimeForPolicy(t *testing.T, launcherID string, wantEnabled bool) *runtime.ResidentRuntime {
	t.Helper()
	launcher, err := harness.GetLauncher(launcherID)
	if err != nil {
		t.Fatalf("launcher %q: %v", launcherID, err)
	}
	if launcher.TaskSessionContinuation != wantEnabled {
		t.Fatalf("launcher %q policy mismatch: got %v want %v", launcherID, launcher.TaskSessionContinuation, wantEnabled)
	}
	rt := runtime.NewResidentRuntime(runtime.Options{
		InstanceID:              "policy-" + launcherID,
		RoomID:                  "handoff-room",
		Name:                    "Agent " + launcherID,
		Client:                  &recordingClient{},
		Adapter:                 &handoffAdapter{stubAdapter: &stubAdapter{name: launcherID}},
		TaskSessionContinuation: launcher.TaskSessionContinuation,
		DisposableWorkspaceRoot: WorkspacesRoot(),
	})
	t.Cleanup(rt.Stop)
	return rt
}
