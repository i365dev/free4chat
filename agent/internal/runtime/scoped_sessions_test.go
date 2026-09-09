package runtime

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
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

type legacyOnlyAdapter struct {
	ensureCalls     int
	generationCalls int
	runCalls        int
	generation      int64
	turns           []string
}

func (a *legacyOnlyAdapter) Name() string { return "legacy-only" }

func (a *legacyOnlyAdapter) Capabilities() *types.HarnessCapabilities {
	return &types.HarnessCapabilities{Text: true}
}

func (a *legacyOnlyAdapter) EnsureSession() error {
	a.ensureCalls++
	if a.generation == 0 {
		a.generation = 1
	}
	return nil
}

func (a *legacyOnlyAdapter) SessionGeneration() int64 {
	a.generationCalls++
	return a.generation
}

func (a *legacyOnlyAdapter) RunTurn(input types.HarnessTurnInput, _ int64) (types.HarnessTurnResult, error) {
	a.runCalls++
	texts := make([]string, 0, len(input.Events))
	for _, event := range input.Events {
		if event.Text != "" {
			texts = append(texts, event.Text)
		}
	}
	a.turns = append(a.turns, strings.Join(texts, ","))
	return types.HarnessTurnResult{Text: "legacy-reply"}, nil
}

func (a *legacyOnlyAdapter) OnFailure(types.AdapterFailureHandler) {}
func (a *legacyOnlyAdapter) CancelTurn() error                     { return nil }
func (a *legacyOnlyAdapter) Close() error                          { return nil }

type diagnosticFakeAdapter struct {
	*fakeAdapter
	diagnostics []types.HarnessSessionDiagnostic
}

func (a *diagnosticFakeAdapter) SessionDiagnostics() []types.HarnessSessionDiagnostic {
	return append([]types.HarnessSessionDiagnostic(nil), a.diagnostics...)
}

func TestStatusProjectsOptionalHarnessSessionDiagnostics(t *testing.T) {
	want := []types.HarnessSessionDiagnostic{
		{Scope: "room", SessionID: "room-session", Generation: 1},
		{Scope: "task:T", SessionID: "task-session", Generation: 1},
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "status-test",
		RoomID:     "room-status",
		Name:       "Agent",
		Client:     &fakeClient{},
		Adapter: &diagnosticFakeAdapter{
			fakeAdapter: &fakeAdapter{name: "pi"},
			diagnostics: want,
		},
	})
	defer rt.Stop()

	status := rt.Status()
	if !reflect.DeepEqual(status.HarnessSessions, want) {
		t.Fatalf("Runtime status lost optional Harness session diagnostics: got=%+v want=%+v", status.HarnessSessions, want)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	if !strings.Contains(string(encoded), `"harnessSessions"`) ||
		!strings.Contains(string(encoded), `"sessionId":"room-session"`) {
		t.Fatalf("status JSON omitted Harness session diagnostics: %s", encoded)
	}
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

func TestTaskScopedHarnessOutputPreservesRequestCorrelation(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	client := &fakeClient{}
	rt := NewResidentRuntime(Options{
		InstanceID: "scoped-output-test",
		RoomID:     "room-scoped-output",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	defer rt.Stop()

	rt.acceptEvent(scopedEvent(1, "task:T", "T prompt"))
	rt.acceptEvent(scopedEvent(2, "task:U", "U prompt"))
	rt.drainTurns()

	if got := client.snapshotSentTaskRequestIDs(); !reflect.DeepEqual(got, []string{"T", "U"}) {
		t.Fatalf("task output lost Room request correlation: %v", got)
	}
}

func TestLegacyAdapterFailsClosedForTaskScope(t *testing.T) {
	adapter := &legacyOnlyAdapter{}
	rt := NewResidentRuntime(Options{
		InstanceID: "legacy-only-test",
		RoomID:     "room-legacy-only",
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
	defer rt.Stop()

	rt.acceptEvent(roomEvent(1, true))
	rt.acceptEvent(scopedEvent(2, "task:T", "TASK_PRIVATE"))
	rt.drainTurns()

	if !reflect.DeepEqual(adapter.turns, []string{"message-1"}) {
		t.Fatalf("legacy adapter received task context or missed Room context: %v", adapter.turns)
	}
	if adapter.ensureCalls != 1 || adapter.generationCalls != 1 || adapter.runCalls != 1 {
		t.Fatalf("task scope called legacy adapter methods: ensure=%d generation=%d run=%d", adapter.ensureCalls, adapter.generationCalls, adapter.runCalls)
	}
	if got := rt.pendingAddressedSnapshotFor("task:T"); !reflect.DeepEqual(got, []int64{2}) {
		t.Fatalf("unsupported task turn was incorrectly acknowledged: %v", got)
	}
	if status := rt.Status(); status.LastError != errScopedHarnessUnsupported.Error() {
		t.Fatalf("unsupported task scope was not reported explicitly: %+v", status)
	}
	if status := rt.Status(); len(status.HarnessSessions) != 0 {
		t.Fatalf("legacy adapter unexpectedly exposed Harness session diagnostics: %+v", status.HarnessSessions)
	}

	if err := rt.ensureHarnessSession("task:T"); !errors.Is(err, errScopedHarnessUnsupported) {
		t.Fatalf("ensure helper did not fail closed: %v", err)
	}
	if _, err := rt.harnessSessionGeneration("task:T"); !errors.Is(err, errScopedHarnessUnsupported) {
		t.Fatalf("generation helper did not fail closed: %v", err)
	}
	if _, err := rt.runHarnessTurn("task:T", types.HarnessTurnInput{}, 1); !errors.Is(err, errScopedHarnessUnsupported) {
		t.Fatalf("turn helper did not fail closed: %v", err)
	}
	if adapter.ensureCalls != 1 || adapter.generationCalls != 1 || adapter.runCalls != 1 {
		t.Fatalf("direct task helper calls reached legacy adapter: ensure=%d generation=%d run=%d", adapter.ensureCalls, adapter.generationCalls, adapter.runCalls)
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
	rt.acceptEvent(scopedEvent(3, "task:T", "T3"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot("task:T"); !reflect.DeepEqual(got, []bool{true, false, false}) {
		t.Fatalf("same scope did not reuse its retained conversation: %v", got)
	}
	if got := adapter.scopedGenerationSnapshot("task:T"); got != 1 {
		t.Fatalf("same task follow-ups changed ACP generation: %d", got)
	}

	// A Room reconnect replaces transport credentials but does not create a
	// new ACP conversation for the surviving task scope.
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent-rejoined",
		ParticipantHandle: "room-secret-2",
		Cursor:            10,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	rt.acceptEvent(scopedEvent(4, "task:T", "T4"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot("task:T"); !reflect.DeepEqual(got, []bool{true, false, false, false}) {
		t.Fatalf("Room reconnect reset task Harness session: %v", got)
	}
	if got := adapter.scopedGenerationSnapshot("task:T"); got != 1 {
		t.Fatalf("Room reconnect changed ACP generation: %d", got)
	}

	adapter.recreateScopedSession("task:T")
	rt.acceptEvent(scopedEvent(5, "task:T", "T5"))
	rt.drainTurns()
	if got := adapter.scopedSessionNewSnapshot("task:T"); !reflect.DeepEqual(got, []bool{true, false, false, false, true}) {
		t.Fatalf("scoped Harness replacement did not request bootstrap: %v", got)
	}
	if got := adapter.scopedGenerationSnapshot("task:T"); got != 2 {
		t.Fatalf("replacement did not advance ACP generation: %d", got)
	}
	_, details := adapter.scopedRunSnapshot()
	if !reflect.DeepEqual(details["task:T"], []string{"T1", "T2", "T3", "T4", "T5"}) {
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

func TestLogicalTaskScopeCapacityEmitsCanonicalFailedCollabResult(t *testing.T) {
	adapter := &fakeAdapter{name: "pi"}
	client := &fakeClient{}
	rt := NewResidentRuntime(Options{
		InstanceID: "capacity-collab-test",
		RoomID:     "room-capacity-collab",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "room-secret",
		Cursor:            0,
		ExpiresAt:         time.Now().Add(time.Hour).UnixMilli(),
	})
	defer rt.Stop()

	for index := 0; index < types.MaxLogicalTaskScopes; index++ {
		rt.acceptEvent(scopedEvent(int64(index+1), "task:"+itoa(int64(index+1)), "scope-"+itoa(int64(index+1))))
	}
	rt.drainTurns()
	initialRuns, initialDetails := adapter.scopedRunSnapshot()

	overflow := scopedEvent(100, "task:overflow-request", "OVERFLOW_TASK_MARKER")
	overflow.Type = "action"
	overflow.ActionType = "collab"
	overflow.Collab = &types.WireCollabEvent{
		RequestID: "overflow-request",
		Kind:      types.CollabRequest,
	}
	rt.acceptEvent(overflow)

	rt.mu.Lock()
	if len(rt.scopedSessions) != types.MaxLogicalTaskScopes || len(rt.scopeOrder) != types.MaxLogicalTaskScopes {
		rt.mu.Unlock()
		t.Fatalf("capacity rejection changed scope state: sessions=%d order=%d", len(rt.scopedSessions), len(rt.scopeOrder))
	}
	buffered := rt.eventBuffer.Snapshot()
	rt.mu.Unlock()
	for _, event := range buffered {
		if event.Sequence == overflow.Sequence {
			t.Fatalf("capacity rejection entered EventBuffer: %#v", event)
		}
	}
	if runs, details := adapter.scopedRunSnapshot(); !reflect.DeepEqual(runs, initialRuns) || !reflect.DeepEqual(details, initialDetails) {
		t.Fatalf("capacity rejection reached Harness: before=%v/%v after=%v/%v", initialRuns, initialDetails, runs, details)
	}
	if got := rt.pendingAddressedSnapshotFor("task:overflow-request"); got != nil {
		t.Fatalf("capacity rejection created pending delivery: %v", got)
	}
	client.mu.Lock()
	results := append([]types.CollabResultArgs(nil), client.collabResults...)
	client.mu.Unlock()
	if len(results) != 1 {
		t.Fatalf("expected exactly one canonical capacity result, got %d: %#v", len(results), results)
	}
	if results[0].RequestID != "overflow-request" || results[0].Status != "failed" || results[0].Summary != "Agent cannot start another task right now." {
		t.Fatalf("unexpected capacity result: %#v", results[0])
	}

	// Existing task scopes and ordinary Room remain usable at capacity.
	rt.acceptEvent(scopedEvent(101, "task:1", "scope-1-after-capacity"))
	rt.acceptEvent(roomEvent(102, true))
	rt.drainTurns()
	if runs, details := adapter.scopedRunSnapshot(); len(runs) != types.MaxLogicalTaskScopes+1 || !reflect.DeepEqual(details["task:1"], []string{"scope-1", "scope-1-after-capacity"}) {
		t.Fatalf("existing task scope did not remain usable: runs=%v details=%#v", runs, details)
	}
	adapter.mu.Lock()
	roomTurns := append([]string(nil), adapter.turnDtls...)
	adapter.mu.Unlock()
	if !reflect.DeepEqual(roomTurns, []string{"message-102"}) {
		t.Fatalf("ordinary Room event did not remain usable: %v", roomTurns)
	}

	// A non-collaboration scope rejection must not fabricate a result card.
	rt.acceptEvent(scopedEvent(103, "task:internal-overflow", "INTERNAL_OVERFLOW_MARKER"))
	client.mu.Lock()
	resultCount := len(client.collabResults)
	client.mu.Unlock()
	if resultCount != 1 {
		t.Fatalf("non-collab scope rejection fabricated a result: %d", resultCount)
	}
}
