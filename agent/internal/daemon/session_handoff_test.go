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
 * Pi-only / one-pending-adoption rules.
 */

// handoffAdapter is a Pi-named Harness exposing the optional session
// primitives, which is exactly the local seam the Runtime handoff path uses.
type handoffAdapter struct {
	*stubAdapter
	page    harness.ACPSessionPage
	listErr error
	loadErr error
	loads   []string
}

func (a *handoffAdapter) ListSessions(cwd string, cursor string) (harness.ACPSessionPage, error) {
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

// registerHandoffResident injects one resident backed by the given adapter.
func registerHandoffResident(t *testing.T, d *Daemon, instanceID, adapterName string, adapter types.HarnessAdapter) {
	t.Helper()
	rt := runtime.NewResidentRuntime(runtime.Options{
		InstanceID: instanceID,
		RoomID:     "handoff-room",
		Name:       "Agent " + adapterName,
		Client:     &recordingClient{},
		Adapter:    adapter,
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
		SessionCwd:         "/workspace/project",
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

	result, err := d.Dispatch(&IpcRequest{Op: "handoff-list", InstanceID: "pi-list", SessionCwd: "/workspace/project"})
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

func TestHandoffDispatchRejectsUnknownOrNonPiResident(t *testing.T) {
	d, _ := startDaemon(t)
	registerHandoffResident(t, d, "codex-handoff", "codex", &stubAdapter{name: "codex"})

	if _, err := d.Dispatch(&IpcRequest{Op: "handoff-adopt", InstanceID: "missing", SessionID: "native-1"}); err == nil {
		t.Fatal("an unknown instance must be rejected")
	}
	for _, op := range []string{"handoff-adopt", "handoff-list"} {
		request := &IpcRequest{Op: op, InstanceID: "codex-handoff", SessionID: "native-1"}
		if _, err := d.Dispatch(request); err == nil || !strings.Contains(err.Error(), "Pi Harness only") {
			t.Fatalf("%s must reject a non-Pi resident by name, got %v", op, err)
		}
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
