package runtime

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func newScopedRuntimeFixture(t *testing.T, adapter *fakeAdapter) *ResidentRuntime {
	t.Helper()
	rt := NewResidentRuntime(Options{
		InstanceID: "scoped-test",
		RoomID:     "room-scoped",
		Name:       "Agent",
		Client:     &fakeClient{},
		Adapter:    adapter,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	return rt
}

func scopedEvent(sequence int64, scope, text string) types.RoomEvent {
	event := roomEvent(sequence, true)
	event.ScopeID = scope
	event.Text = text
	return event
}

func TestLogicalScopesReuseIsolatedHarnessSessions(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	rt := newScopedRuntimeFixture(t, adapter)
	defer rt.Stop()

	for _, event := range []types.RoomEvent{
		{Sequence: 1, Type: "text", Participant: types.ParticipantIdentity{ID: "human", Name: "Human", Kind: types.KindHuman}, Text: "ROOM_MARKER", Addressed: true},
		scopedEvent(2, "task:T", "TASK_T_MARKER"),
		scopedEvent(3, "task:U", "TASK_U_MARKER"),
	} {
		rt.acceptEvent(event)
	}
	rt.drainTurns()

	runs, details := adapter.scopedRunSnapshot()
	if !reflect.DeepEqual(runs, []string{"task:T", "task:U"}) {
		t.Fatalf("unexpected task session routing: %v", runs)
	}
	if !reflect.DeepEqual(details["task:T"], []string{"TASK_T_MARKER"}) ||
		!reflect.DeepEqual(details["task:U"], []string{"TASK_U_MARKER"}) {
		t.Fatalf("task contexts crossed scopes: %#v", details)
	}
	adapter.mu.Lock()
	roomTurns := append([]string(nil), adapter.turnDtls...)
	adapter.mu.Unlock()
	if !reflect.DeepEqual(roomTurns, []string{"ROOM_MARKER"}) {
		t.Fatalf("Room scope inherited task context: %v", roomTurns)
	}

	for _, event := range []types.RoomEvent{
		scopedEvent(4, "task:T", "TASK_T_MARKER_2"),
		scopedEvent(5, "task:U", "TASK_U_MARKER_2"),
	} {
		rt.acceptEvent(event)
	}
	rt.drainTurns()
	runs, details = adapter.scopedRunSnapshot()
	if !reflect.DeepEqual(runs, []string{"task:T", "task:U", "task:T", "task:U"}) {
		t.Fatalf("alternating turns did not return to retained scopes: %v", runs)
	}
	if !reflect.DeepEqual(details["task:T"], []string{"TASK_T_MARKER", "TASK_T_MARKER_2"}) ||
		!reflect.DeepEqual(details["task:U"], []string{"TASK_U_MARKER", "TASK_U_MARKER_2"}) {
		t.Fatalf("alternating scope context was not retained: %#v", details)
	}
}

func TestScopedDeliveryFailureDoesNotAdvanceAnotherScope(t *testing.T) {
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("T failed")}
	rt := newScopedRuntimeFixture(t, adapter)
	defer rt.Stop()
	rt.acceptEvent(scopedEvent(1, "task:T", "T1"))
	rt.acceptEvent(scopedEvent(2, "task:U", "U1"))

	rt.drainTurns()
	if got := rt.deliveredSeqFor("task:U"); got != 1 {
		t.Fatalf("U delivery advanced while T failed: %d", got)
	}
	if got := rt.pendingAddressedSnapshotFor("task:U"); !reflect.DeepEqual(got, []int64{2}) {
		t.Fatalf("U pending delivery was acknowledged by T failure: %v", got)
	}

	adapter.mu.Lock()
	adapter.turnErr = nil
	adapter.mu.Unlock()
	rt.drainTurns()
	if got := rt.deliveredSeqFor("task:T"); got != 1 {
		t.Fatalf("T retry did not acknowledge its own delivery: %d", got)
	}
	if got := rt.deliveredSeqFor("task:U"); got != 2 {
		t.Fatalf("U delivery did not advance after its own success: %d", got)
	}
}

func TestScopedSessionGenerationAndRoomReconnectAreTruthful(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	rt := newScopedRuntimeFixture(t, adapter)
	defer rt.Stop()

	rt.acceptEvent(scopedEvent(1, "task:T", "T1"))
	rt.drainTurns()
	rt.acceptEvent(scopedEvent(2, "task:T", "T2"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot("task:T"); !reflect.DeepEqual(got, []bool{true, false}) {
		t.Fatalf("same scope did not reuse its retained conversation: %v", got)
	}

	// A Room reconnect replaces transport credentials but does not create a
	// new ACP conversation for the surviving task scope.
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent-rejoined",
		ParticipantHandle: "room-secret-2",
		Cursor:            10,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	rt.acceptEvent(scopedEvent(3, "task:T", "T3"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot("task:T"); !reflect.DeepEqual(got, []bool{true, false, false}) {
		t.Fatalf("Room reconnect reset task Harness session: %v", got)
	}

	adapter.recreateScopedSession("task:T")
	rt.acceptEvent(scopedEvent(4, "task:T", "T4"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot("task:T"); !reflect.DeepEqual(got, []bool{true, false, false, true}) {
		t.Fatalf("scoped Harness replacement did not request bootstrap: %v", got)
	}
	_, details := adapter.scopedRunSnapshot()
	if !reflect.DeepEqual(details["task:T"], []string{"T1", "T2", "T3", "T4"}) {
		t.Fatalf("new session replayed unrelated private context: %#v", details)
	}
}

func TestLogicalTaskSourceCursorsAreIndependentAndObservationDoesNotRunTurn(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	rt := newScopedRuntimeFixture(t, adapter)
	defer rt.Stop()

	rt.observeLogicalSource("task:T", "domain-a", 7)
	rt.observeLogicalSource("task:T", "domain-b", 19)
	rt.observeLogicalSource("task:T", "domain-a", 6)
	if got := rt.logicalSourceCursor("task:T", "domain-a"); got != 7 {
		t.Fatalf("domain-a cursor regressed: %d", got)
	}
	if got := rt.logicalSourceCursor("task:T", "domain-b"); got != 19 {
		t.Fatalf("domain-b cursor changed unexpectedly: %d", got)
	}
	if runs, _ := adapter.scopedRunSnapshot(); len(runs) != 0 {
		t.Fatalf("source observation triggered a Harness turn: %v", runs)
	}

	taskAttention := roomEvent(1, true)
	taskAttention.Text = "explicit task attention"
	taskAttention.ActionPayload = map[string]string{"taskId": "T"}
	rt.acceptEvent(taskAttention)
	rt.drainTurns()
	if runs, _ := adapter.scopedRunSnapshot(); !reflect.DeepEqual(runs, []string{"task:T"}) {
		t.Fatalf("explicit task attention was not routed to task scope: %v", runs)
	}
}

func TestSameTaskAcrossTwoResidentsUsesSeparateHarnessBindings(t *testing.T) {
	adapterA := &fakeAdapter{name: "pi-a"}
	adapterB := &fakeAdapter{name: "pi-b"}
	runtimeA := newScopedRuntimeFixture(t, adapterA)
	runtimeB := newScopedRuntimeFixture(t, adapterB)
	defer runtimeA.Stop()
	defer runtimeB.Stop()

	runtimeA.acceptEvent(scopedEvent(1, "task:T", "AGENT_A_PRIVATE"))
	runtimeB.acceptEvent(scopedEvent(1, "task:T", "AGENT_B_PRIVATE"))
	runtimeA.drainTurns()
	runtimeB.drainTurns()

	if runs, details := adapterA.scopedRunSnapshot(); !reflect.DeepEqual(runs, []string{"task:T"}) ||
		!reflect.DeepEqual(details["task:T"], []string{"AGENT_A_PRIVATE"}) {
		t.Fatalf("Agent A task session mismatch: runs=%v details=%#v", runs, details)
	}
	if runs, details := adapterB.scopedRunSnapshot(); !reflect.DeepEqual(runs, []string{"task:T"}) ||
		!reflect.DeepEqual(details["task:T"], []string{"AGENT_B_PRIVATE"}) {
		t.Fatalf("Agent B task session mismatch: runs=%v details=%#v", runs, details)
	}
}
