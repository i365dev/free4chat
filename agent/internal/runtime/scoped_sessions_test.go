package runtime

import (
	"encoding/json"
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

func TestSerializedRoomWireScopeIDRoutesToRetainedTaskSessions(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	rt := newScopedRuntimeFixture(t, adapter)
	defer rt.Stop()

	for _, raw := range []string{
		`{"sequence":1,"type":"action","participant":{"id":"human","name":"Human","kind":"human"},"scopeId":"task:T","actionType":"collab","collab":{"requestId":"T","kind":"request","fromParticipantId":"human","targetParticipantId":"agent"},"addressed":true,"createdAt":1}`,
		`{"sequence":2,"type":"action","participant":{"id":"human","name":"Human","kind":"human"},"scopeId":"task:U","actionType":"collab","collab":{"requestId":"U","kind":"request","fromParticipantId":"human","targetParticipantId":"agent"},"addressed":true,"createdAt":2}`,
	} {
		var event types.RoomEvent
		if err := json.Unmarshal([]byte(raw), &event); err != nil {
			t.Fatalf("serialized Room event did not decode: %v", err)
		}
		rt.acceptEvent(event)
	}
	rt.drainTurns()

	runs, details := adapter.scopedRunSnapshot()
	if !reflect.DeepEqual(runs, []string{"task:T", "task:U"}) {
		t.Fatalf("serialized Room scopes did not route independently: %v", runs)
	}
	if !reflect.DeepEqual(details["task:T"], []string{""}) || !reflect.DeepEqual(details["task:U"], []string{""}) {
		t.Fatalf("unexpected collab task contexts: %#v", details)
	}

	ordinary := roomEvent(3, true)
	rt.acceptEvent(ordinary)
	rt.drainTurns()
	adapter.mu.Lock()
	roomTurns := append([]string(nil), adapter.turnDtls...)
	adapter.mu.Unlock()
	if !reflect.DeepEqual(roomTurns, []string{"message-3"}) {
		t.Fatalf("ordinary Room event did not stay in Room scope: %v", roomTurns)
	}
}

func TestLogicalTaskScopeCapacityFailsClosedWithoutRoomFallback(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	rt := newScopedRuntimeFixture(t, adapter)
	defer rt.Stop()

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		scope := "task:" + itoa(int64(index+1))
		rt.acceptEvent(scopedEvent(int64(index+1), scope, "scope-"+itoa(int64(index+1))))
	}
	rt.drainTurns()
	rt.mu.Lock()
	if len(rt.scopedSessions) != types.MaxLogicalTaskScopes || len(rt.scopeOrder) != types.MaxLogicalTaskScopes {
		rt.mu.Unlock()
		t.Fatalf("scope bound was not admitted exactly: sessions=%d order=%d", len(rt.scopedSessions), len(rt.scopeOrder))
	}
	rt.mu.Unlock()
	initialRuns, initialDetails := adapter.scopedRunSnapshot()

	// The ninth scope is rejected before it can enter EventBuffer, pending
	// delivery, the Room session, or ACP session creation.
	rt.acceptEvent(scopedEvent(100, "task:overflow", "MUST-NOT-LEAK"))
	rt.drainTurns()
	runs, details := adapter.scopedRunSnapshot()
	if !reflect.DeepEqual(runs, initialRuns) || !reflect.DeepEqual(details, initialDetails) {
		t.Fatalf("rejected scope changed Harness state: before=%v/%v after=%v/%v", initialRuns, initialDetails, runs, details)
	}
	if got := adapter.scopedSessionNewSnapshot("task:overflow"); got != nil {
		t.Fatalf("rejected scope created a scoped session: %v", got)
	}

	// Existing scopes remain reusable at capacity and retain their conversation.
	rt.acceptEvent(scopedEvent(101, "task:1", "scope-1-again"))
	rt.drainTurns()
	runs, details = adapter.scopedRunSnapshot()
	if len(runs) != types.MaxLogicalTaskScopes+1 || !reflect.DeepEqual(details["task:1"], []string{"scope-1", "scope-1-again"}) {
		t.Fatalf("existing scope was not reusable at capacity: runs=%v details=%#v", runs, details)
	}
	if got := adapter.scopedSessionNewSnapshot("task:1"); !reflect.DeepEqual(got, []bool{true, false}) {
		t.Fatalf("existing scope did not retain its ACP conversation: %v", got)
	}

	// A later ordinary Room event still works, but it cannot contain the
	// rejected scope's private trigger.
	rt.acceptEvent(roomEvent(102, true))
	rt.drainTurns()
	adapter.mu.Lock()
	roomTurns := append([]string(nil), adapter.turnDtls...)
	adapter.mu.Unlock()
	if !reflect.DeepEqual(roomTurns, []string{"message-102"}) {
		t.Fatalf("rejected task fell back into Room context: %v", roomTurns)
	}
}
