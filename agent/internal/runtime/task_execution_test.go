package runtime

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Remote Task execution projection (#409).
 *
 * These tests pin the projection against the Runtime's REAL serialized
 * pending-turn queue: no new queue, no new scheduler, no second turn identity.
 */

// executionClient records the transient Task execution projections this
// Runtime published.
type executionClient struct {
	*fakeClient
	mu          sync.Mutex
	projections []types.TaskExecutionProjection
	updateErr   error
}

func newExecutionClient() *executionClient {
	return &executionClient{fakeClient: &fakeClient{}}
}

func (c *executionClient) UpdateTaskExecution(_ string, projection types.TaskExecutionProjection) error {
	c.mu.Lock()
	c.projections = append(c.projections, projection)
	err := c.updateErr
	c.mu.Unlock()
	return err
}

// projectionCount reports how many projections this Runtime published. It is
// how a test observes a bounded reconciliation republication.
func (c *executionClient) projectionCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.projections)
}

func (c *executionClient) latest(taskRequestID string) (types.TaskExecutionProjection, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for index := len(c.projections) - 1; index >= 0; index-- {
		if c.projections[index].TaskRequestID == taskRequestID {
			return c.projections[index], true
		}
	}
	return types.TaskExecutionProjection{}, false
}

func newExecutionRuntime(t *testing.T) (*ResidentRuntime, *interruptAdapter, *executionClient) {
	t.Helper()
	adapter := newInterruptAdapter()
	client := newExecutionClient()
	rt := NewResidentRuntime(Options{
		InstanceID: "task-execution",
		RoomID:     "room-task-execution",
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
	return rt, adapter, client
}

// waitForExecution waits for the newest published projection of one Task to
// satisfy a predicate.
func waitForExecution(
	t *testing.T,
	client *executionClient,
	taskRequestID string,
	message string,
	matches func(types.TaskExecutionProjection) bool,
) types.TaskExecutionProjection {
	t.Helper()
	var last types.TaskExecutionProjection
	waitFor(t, 2*time.Second, func() bool {
		projection, ok := client.latest(taskRequestID)
		if !ok {
			return false
		}
		last = projection
		return matches(projection)
	}, message)
	return last
}

func TestTaskExecutionRunningAndSameTaskQueue(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	first := startTurn(rt, scopedEvent(10, "task:req-T", "first instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	running := waitForExecution(t, client, "req-T", "running projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 10 && p.Phase == types.TaskExecutionPhaseRunning
	})
	if running.QueuedCount != 0 {
		t.Fatalf("a running turn with an empty queue reported %d queued", running.QueuedCount)
	}

	// A follow-up sent while the turn runs is exactly "send after current
	// turn": the existing serial queue grows, the current turn does not change.
	rt.acceptEvent(scopedEvent(11, "task:req-T", "second instruction"))
	queued := waitForExecution(t, client, "req-T", "queued follow-up projection", func(p types.TaskExecutionProjection) bool {
		return p.QueuedCount == 1
	})
	if queued.CurrentTurnSequence != 10 || queued.Phase != types.TaskExecutionPhaseRunning {
		t.Fatalf("queueing changed the current turn: %+v", queued)
	}

	// The queued successor runs next, on the same Task scope. It parks on a
	// fresh gate so its own running projection is observable.
	adapter.blockNextTurn()
	adapter.releaseTurn()
	waitFor(t, 2*time.Second, func() bool { return adapter.runCount("task:req-T") >= 2 }, "queued successor turn")
	successor := waitForExecution(t, client, "req-T", "successor turn projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 11
	})
	if successor.QueuedCount != 0 || successor.Phase != types.TaskExecutionPhaseRunning {
		t.Fatalf("successor projection mismatch: %+v", successor)
	}
	adapter.releaseTurn()
	// The single serial drain owns both turns, so it only returns once the
	// successor has settled too.
	waitForDone(t, first, "both turns to settle")
}

func TestTaskExecutionShowsATaskQueuedBehindAnotherTasksTurn(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	// Task U owns the only execution lane this default (serial) policy allows.
	startTurn(rt, scopedEvent(20, "task:req-U", "U instruction"))
	waitForActiveScope(t, rt, "task:req-U")

	// Task T has no current turn but one accepted instruction waiting.
	rt.acceptEvent(scopedEvent(21, "task:req-T", "T instruction"))
	queued := waitForExecution(t, client, "req-T", "queued Task projection", func(p types.TaskExecutionProjection) bool {
		return p.QueuedCount == 1
	})
	// #421: a Task behind the bounded lane count has NO current turn. It
	// reports the explicit QUEUED phase instead, so "waiting for capacity" is
	// distinguishable from "hanging" without pretending a turn is executing.
	if queued.CurrentTurnSequence != 0 || queued.Phase != types.TaskExecutionPhaseQueued {
		t.Fatalf("a Task behind another Task must report the queued phase: %+v", queued)
	}
	adapter.releaseTurn()
	waitFor(t, 2*time.Second, func() bool { return activeScope(rt) == "" }, "turn to settle")
}

func TestTaskExecutionInterruptingThenInterrupted(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	// The turn must stay parked AFTER the cancel dispatch returns, so arm the
	// hold barrier before it starts.
	adapter.holdTurn = make(chan struct{})
	drained := startTurn(rt, scopedEvent(30, "task:req-T", "long instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	waitForExecution(t, client, "req-T", "running projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 30 && p.Phase == types.TaskExecutionPhaseRunning
	})

	// The exact-turn interrupt is authorized and dispatched, so the same exact
	// turn becomes "interrupting" without changing identity. The turn stays
	// parked (holdTurn is not released by CancelTurn), so the post-dispatch
	// phase is observable rather than racing the settlement.
	rt.applyResidentTaskControl(interruptControl("req-T", 30))
	waitForExecution(t, client, "req-T", "interrupting projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 30 && p.Phase == types.TaskExecutionPhaseInterrupting
	})
	close(adapter.holdTurn)
	waitForDone(t, drained, "interrupted turn to settle")

	// No successor exists, so the Task shows the intentional settlement.
	settled := waitForExecution(t, client, "req-T", "interrupted projection", func(p types.TaskExecutionProjection) bool {
		return p.LastOutcome == types.TaskExecutionOutcomeInterrupted
	})
	if settled.CurrentTurnSequence != 0 || settled.Phase != "" {
		t.Fatalf("a settled turn stayed current: %+v", settled)
	}
}

// TestIntentionalInterruptIsTerminalAndNeverRetries is the critical settlement
// test: a Harness failure after an accepted Human interrupt must not be treated
// as a retryable turn failure.
func TestIntentionalInterruptIsTerminalAndNeverRetries(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()
	// The owned turn fails (not merely returns text) once it is cancelled.
	adapter.fakeAdapter.turnErr = errors.New("harness failed after cancel")

	drained := startTurn(rt, scopedEvent(40, "task:req-T", "instruction to stop"))
	waitForActiveScope(t, rt, "task:req-T")
	rt.applyResidentTaskControl(interruptControl("req-T", 40))
	waitForDone(t, drained, "interrupted turn to settle")

	if runs := adapter.runCount("task:req-T"); runs != 1 {
		t.Fatalf("an intentionally interrupted turn must run exactly once, got %d", runs)
	}
	rt.mu.Lock()
	// #421: the retry budget is keyed per canonical turn, so "no retry armed
	// for this turn" is an absent entry rather than nil/zero globals.
	retryState := rt.turnRetries[canonicalTurnKey{scope: "task:req-T", target: 40}]
	pending := 0
	if ref := rt.sessionRefLocked("task:req-T"); ref != nil && ref.pendingAddressed != nil {
		pending = len(*ref.pendingAddressed)
	}
	rt.mu.Unlock()
	if retryState != nil {
		t.Fatalf("an interrupted turn armed autonomous retry: %+v", retryState)
	}
	if pending != 0 {
		t.Fatalf("the interrupted trigger stayed pending: %d", pending)
	}
	// No retry clock may resurrect it either.
	time.Sleep(10 * time.Millisecond)
	if got := adapter.runCount("task:req-T"); got != 1 {
		t.Fatalf("the interrupted trigger was replayed: %d runs", got)
	}
	outcome := waitForExecution(t, client, "req-T", "interrupted outcome", func(p types.TaskExecutionProjection) bool {
		return p.LastOutcome == types.TaskExecutionOutcomeInterrupted
	})
	if outcome.Availability != "" {
		t.Fatalf("a cancelled turn must not claim a lost session: %+v", outcome)
	}
}

func TestIntentionalInterruptSuppressesOutputAndRunsTheQueuedSuccessor(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	drained := startTurn(rt, scopedEvent(50, "task:req-T", "first instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	// The replacement instruction is already durably queued.
	rt.acceptEvent(scopedEvent(51, "task:req-T", "replacement instruction"))
	waitForExecution(t, client, "req-T", "queued replacement", func(p types.TaskExecutionProjection) bool {
		return p.QueuedCount == 1
	})

	rt.applyResidentTaskControl(interruptControl("req-T", 50))
	waitForDone(t, drained, "interrupted turn to settle")

	// The cancelled turn's own reply is never published, and its successor
	// runs exactly once.
	waitFor(t, 2*time.Second, func() bool { return adapter.runCount("task:req-T") >= 2 }, "queued successor to run")
	if got := adapter.runCount("task:req-T"); got != 2 {
		t.Fatalf("the interrupted turn was retried: %d runs", got)
	}
	sent := client.snapshotSent()
	if len(sent) != 1 {
		t.Fatalf("only the successor reply may be published, got %v", sent)
	}
	adapter.releaseTurn()
	waitFor(t, 2*time.Second, func() bool { return activeScope(rt) == "" }, "successor turn to settle")
}

func TestTaskExecutionSessionLostOnlyForRealHarnessDeath(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	// A completed Task turn proves this scope had a retained Harness session.
	drained := startTurn(rt, scopedEvent(60, "task:req-T", "instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	adapter.releaseTurn()
	waitForDone(t, drained, "turn to settle")

	// A Room/resident transport reconnect is NOT Harness session loss.
	rt.setResidentStream(newGatedResidentStream())
	time.Sleep(10 * time.Millisecond)
	if projection, ok := client.latest("req-T"); ok && projection.Availability != "" {
		t.Fatalf("a transport reconnect claimed a lost session: %+v", projection)
	}

	// Unexpected Harness process death is.
	adapter.fireFailure(errors.New("harness exited"))
	lost := waitForExecution(t, client, "req-T", "session lost projection", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilitySessionLost
	})
	if lost.CurrentTurnSequence != 0 || lost.Phase != "" {
		t.Fatalf("a lost session still claimed a current turn: %+v", lost)
	}

	// A later instruction starts a genuinely fresh session: availability
	// clears and nothing claims the previous session was resumed.
	adapter.blockNextTurn()
	again := startTurn(rt, scopedEvent(61, "task:req-T", "instruction after loss"))
	recovered := waitForExecution(t, client, "req-T", "recovered projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 61
	})
	if recovered.Availability != "" {
		t.Fatalf("a fresh turn did not clear the lost session: %+v", recovered)
	}
	adapter.releaseTurn()
	waitForDone(t, again, "recovered turn to settle")
}

func TestExhaustedTaskDeliveryQuarantinesOldQueueAndNewHumanInstructionRecovers(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	const scope = "task:req-T"
	initial := startTurn(rt, scopedEvent(200, scope, "initial task"))
	waitForActiveScope(t, rt, scope)
	adapter.releaseTurn()
	waitForDone(t, initial, "initial Task turn")
	if got := adapter.runCount(scope); got != 1 {
		t.Fatalf("initial Task did not complete before follow-up: run count=%d", got)
	}

	// A Harness turn failure after the initial Task has settled leaves this
	// ordinary follow-up undelivered. Once the small retry budget is exhausted,
	// Runtime bookkeeping is discarded while the canonical Room history stays
	// untouched.
	rt.acceptEvent(scopedEvent(201, scope, "follow-up that fails in Harness"))
	rt.turnRetryDelay = func(int) time.Duration { return time.Hour }
	for attempt := 0; attempt <= maxTurnRetryAttempts; attempt++ {
		rt.failTurn(scope, 201, "harness", turnFailureOther, time.Now(), errors.New("Harness turn failed"), true)
	}
	if rt.turnRetryIndexFor(scope, 201) != 0 {
		t.Fatal("exhausted Task retry state was retained as executable work")
	}
	attention := waitForExecution(t, client, "req-T", "exhausted Harness follow-up needs attention", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilityNeedsAttention && p.QueuedCount == 0
	})
	if attention.Phase == types.TaskExecutionPhaseQueued || attention.CurrentTurnSequence != 0 {
		t.Fatalf("an exhausted Harness follow-up was presented as lane contention: %+v", attention)
	}
	if pending := rt.pendingAddressedSnapshotFor(scope); len(pending) != 0 {
		t.Fatalf("failed Task bookkeeping remained queued after exhaustion: %v", pending)
	}
	if got := adapter.runCount(scope); got != 1 {
		t.Fatalf("failed follow-up entered automatic Harness retry unexpectedly: run count=%d", got)
	}

	// New Human work is the escape hatch. It clears attention, excludes the
	// old failed instruction from its Runtime context, and reaches Harness once.
	rt.acceptEvent(scopedEvent(202, scope, "fresh Human instruction C"))
	rt.drainTurns()
	if got := adapter.runCount(scope); got != 2 {
		t.Fatalf("fresh Human instruction did not reach Harness exactly once: run count=%d", got)
	}
	if pending := rt.pendingAddressedSnapshotFor(scope); len(pending) != 0 {
		t.Fatalf("fresh instruction did not settle normally: %v", pending)
	}
	_, details := adapter.scopedRunSnapshot()
	if got := details[scope][1]; got != "fresh Human instruction C" {
		t.Fatalf("old failed instructions leaked into the recovery turn: %q", got)
	}
	recovered := waitForExecution(t, client, "req-T", "Task usable after new Human instruction", func(p types.TaskExecutionProjection) bool {
		return p.Availability == "" && p.CurrentTurnSequence == 0 && p.QueuedCount == 0
	})
	if recovered.Phase == types.TaskExecutionPhaseQueued {
		t.Fatalf("recovered Task retained fake queue contention: %+v", recovered)
	}
}

func TestOrdinaryHumanMessageDoesNotResetBoundedRetryBudget(t *testing.T) {
	rt, _, _ := newExecutionRuntime(t)
	defer rt.Stop()
	rt.turnRetryDelay = func(int) time.Duration { return time.Hour }
	const scope = "task:req-T"
	rt.acceptEvent(scopedEvent(110, scope, "instruction B"))
	rt.failTurn(scope, 110, "harness", turnFailureOther, time.Now(), errors.New("temporary failure"), true)
	if got := rt.turnRetryIndexFor(scope, 110); got != 1 {
		t.Fatalf("first bounded retry attempt = %d, want 1", got)
	}
	rt.acceptEvent(scopedEvent(111, scope, "ordinary Human instruction C"))
	if got := rt.turnRetryIndexFor(scope, 110); got != 1 {
		t.Fatalf("new ordinary Human message reset the old retry budget to %d", got)
	}
	if pending := rt.pendingAddressedSnapshotFor(scope); !reflect.DeepEqual(pending, []int64{110, 111}) {
		t.Fatalf("ordinary Human message changed the pending queue while retrying: %v", pending)
	}
}

func TestNewHumanInstructionRechecksUnavailableControlWithoutRetryLoop(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	// The Task's existing session works until a Human selects a native control
	// that this adapter cannot apply. The failed second instruction is never
	// delivered to the Harness.
	initial := startTurn(rt, scopedEvent(130, "task:req-T", "previous turn completes"))
	waitForActiveScope(t, rt, "task:req-T")
	adapter.releaseTurn()
	waitForDone(t, initial, "previous turn to complete")
	rt.mu.Lock()
	rt.taskIdentities["task:req-T"] = &taskIdentity{modeID: "workspace"}
	rt.mu.Unlock()
	rt.acceptEvent(scopedEvent(131, "task:req-T", "selected native mode instruction"))
	rt.drainTurns()
	blocked := waitForExecution(t, client, "req-T", "unavailable selected control blocks Task", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilityControlUnavailable
	})
	if blocked.Phase == types.TaskExecutionPhaseQueued || adapter.runCount("task:req-T") != 1 {
		t.Fatalf("pre-Harness control failure was shown as queue contention or delivered: projection=%+v runs=%d", blocked, adapter.runCount("task:req-T"))
	}

	rt.acceptEvent(scopedEvent(132, "task:req-T", "later ordinary instruction"))
	rt.drainTurns()
	if adapter.runCount("task:req-T") != 1 || len(rt.pendingAddressedSnapshotFor("task:req-T")) != 0 {
		t.Fatalf("exhausted work remained executable after attention: runs=%d pending=%v", adapter.runCount("task:req-T"), rt.pendingAddressedSnapshotFor("task:req-T"))
	}

	latest := scopedEvent(133, "task:req-T", "fresh Human instruction")
	rt.acceptEvent(latest)
	rt.drainTurns()
	stillBlocked := waitForExecution(t, client, "req-T", "still-unavailable control re-blocks fresh instruction", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilityControlUnavailable && p.QueuedCount == 0
	})
	if stillBlocked.Phase == types.TaskExecutionPhaseQueued || adapter.runCount("task:req-T") != 1 ||
		len(rt.pendingAddressedSnapshotFor("task:req-T")) != 0 {
		t.Fatalf("fresh instruction bypassed a genuinely unavailable native control: projection=%+v runs=%d pending=%v", stillBlocked, adapter.runCount("task:req-T"), rt.pendingAddressedSnapshotFor("task:req-T"))
	}
	// Replaying a duplicate Room event cannot create an autonomous retry or a
	// second blocked attempt while the underlying provider limitation remains.
	rt.acceptEvent(latest)
	rt.drainTurns()
	time.Sleep(20 * time.Millisecond)
	if adapter.runCount("task:req-T") != 1 || len(rt.pendingAddressedSnapshotFor("task:req-T")) != 0 {
		t.Fatalf("replayed Human instruction caused duplicate work: runs=%d pending=%v", adapter.runCount("task:req-T"), rt.pendingAddressedSnapshotFor("task:req-T"))
	}
}

func TestDiagnosticsSnapshotIdentifiesLiveTaskTurnWithoutTaskContent(t *testing.T) {
	rt, adapter, _ := newExecutionRuntime(t)
	defer rt.Stop()
	adapter.blockNextTurn()
	drained := startTurn(rt, scopedEvent(120, "task:req-private", "private prompt content /private/project-path credential-secret model-secret"))
	waitForActiveScope(t, rt, "task:req-private")

	diagnostic := rt.DiagnosticsSnapshot()
	_, ok := diagnostic["execution"].(map[string]any)
	if !ok {
		t.Fatalf("execution diagnostics are missing: %#v", diagnostic)
	}
	encoded, err := json.Marshal(diagnostic)
	if err != nil {
		t.Fatalf("encode diagnostics: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode diagnostics: %v", err)
	}
	rows, ok := decoded["execution"].(map[string]any)["tasks"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("task execution diagnostic shape = %#v", decoded["execution"])
	}
	row, ok := rows[0].(map[string]any)
	if !ok || row["scopeKind"] != "task" || row["state"] != "running" || row["currentTurnSequence"] != float64(120) {
		t.Fatalf("live Task turn was not diagnosed precisely: %#v", rows[0])
	}
	for _, forbidden := range []string{"req-private", "private prompt content", "/private/project-path", "credential-secret", "model-secret", "native-session-secret"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("diagnostics exposed sensitive Task/Harness data %q: %s", forbidden, encoded)
		}
	}
	adapter.releaseTurn()
	waitForDone(t, drained, "diagnostic Task turn to settle")
	rt.markTaskControlUnavailable("task:req-private", "HARNESS_CONTROL_UNAVAILABLE")
	blocked, err := json.Marshal(rt.DiagnosticsSnapshot())
	if err != nil {
		t.Fatalf("encode blocked diagnostics: %v", err)
	}
	if !strings.Contains(string(blocked), `"state":"blocked"`) ||
		!strings.Contains(string(blocked), `"availabilityReason":"HARNESS_CONTROL_UNAVAILABLE"`) {
		t.Fatalf("blocked Task diagnostics omit the failure class: %s", blocked)
	}
}

type taskDiagnosticsAdapter struct {
	*interruptAdapter
}

func (a *taskDiagnosticsAdapter) DiagnosticsSnapshot() types.HarnessDiagnosticSnapshot {
	return types.HarnessDiagnosticSnapshot{
		Provider: "test",
		Capacity: 1,
		Lanes: []types.HarnessLaneDiagnostic{{
			Lane:        0,
			State:       "idle",
			Scope:       "task:req-provider-private",
			SessionHash: "opaque-session-hash",
		}},
	}
}

func TestDiagnosticsDistinguishRunningRetryingNeedsAttentionAndBlocked(t *testing.T) {
	rt := NewResidentRuntime(Options{
		InstanceID: "diagnostics-state-machine",
		RoomID:     "room-diagnostics-state-machine",
		Name:       "Agent",
		Client:     newExecutionClient(),
		Adapter:    &taskDiagnosticsAdapter{interruptAdapter: newInterruptAdapter()},
	})
	rt.adoptJoin(types.JoinResult{
		ParticipantID: "agent", ParticipantHandle: "room-secret", Cursor: 0,
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	})
	defer rt.Stop()

	scopes := []string{
		"task:req-running-private",
		"task:req-retrying-private",
		"task:req-recovery-private",
		"task:req-blocked-private",
	}
	sequences := []int64{501, 502, 503, 504}
	for index, scope := range scopes {
		rt.acceptEvent(scopedEvent(sequences[index], scope, "prompt-private /private/path model-private credential-private"))
	}
	rt.mu.Lock()
	rt.taskIdentities[scopes[0]] = &taskIdentity{
		projectCwd:    "/private/path",
		configOptions: map[string]string{"model": "model-private"},
	}
	rt.turnRetries[canonicalTurnKey{scope: scopes[1], target: sequences[1]}] = &turnRetryState{
		attempt:      1,
		failureClass: turnFailureTimeout,
		plan: &turnRetryPlan{
			scope: scopes[1], target: sequences[1], failureClass: turnFailureTimeout,
			attempt: 1, dueAt: time.Now().Add(time.Minute),
		},
	}
	rt.turnRetries[canonicalTurnKey{scope: scopes[2], target: sequences[2]}] = &turnRetryState{
		attempt:      maxTurnRetryAttempts,
		failureClass: turnFailureSession,
	}
	rt.mu.Unlock()
	rt.beginActivity(scopes[0], sequences[0])
	rt.markTaskBlockedForFailure(scopes[2], turnFailureSession, false)
	rt.markTaskControlUnavailable(scopes[3], "HARNESS_CONTROL_UNAVAILABLE")

	encoded, err := json.Marshal(rt.DiagnosticsSnapshot())
	if err != nil {
		t.Fatalf("encode execution diagnostics: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode execution diagnostics: %v", err)
	}
	tasks, ok := decoded["execution"].(map[string]any)["tasks"].([]any)
	if !ok || len(tasks) != len(scopes) {
		t.Fatalf("bounded task diagnostics missing: %s", encoded)
	}
	want := map[string]string{
		scopes[0]: "running",
		scopes[1]: "retrying",
		scopes[2]: "needs_attention",
		scopes[3]: "blocked",
	}
	seen := make(map[string]bool, len(want))
	for _, raw := range tasks {
		row := raw.(map[string]any)
		for scope, state := range want {
			if row["scopeKey"] == diagnosticScopeKey(scope) {
				if row["state"] != state {
					t.Fatalf("Task diagnostic %s state = %v, want %s: %s", diagnosticScopeKey(scope), row["state"], state, encoded)
				}
				if scope == scopes[1] && row["retryFailureClass"] != turnFailureTimeout {
					t.Fatalf("retry failure class is not visible: %#v", row)
				}
				if scope == scopes[2] && row["availabilityReason"] != turnFailureSession {
					t.Fatalf("needs-attention failure class is not visible: %#v", row)
				}
				if scope == scopes[2] && row["retryAttempt"] != float64(maxTurnRetryAttempts) {
					t.Fatalf("exhausted retry attempt is not visible: %#v", row)
				}
				seen[scope] = true
			}
		}
	}
	for scope := range want {
		if !seen[scope] {
			t.Fatalf("Task diagnostic missing for %s: %s", diagnosticScopeKey(scope), encoded)
		}
	}
	for _, forbidden := range []string{
		"req-running-private", "req-retrying-private", "req-recovery-private", "req-blocked-private",
		"prompt-private", "/private/path", "credential-private", "model-private", "native-session-secret", "req-provider-private",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("diagnostics exposed sensitive value %q: %s", forbidden, encoded)
		}
	}
}

func TestDirectContextRetryExhaustionNeedsAttentionAndAllowsNewInstruction(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	const scope = "task:req-T"
	const sequence = int64(205)
	event := scopedEvent(sequence, scope, "instruction with unavailable context")
	rt.acceptEvent(event)
	// Model local snapshot loss followed by a failed authenticated Room read.
	rt.mu.Lock()
	ref := rt.sessionRefLocked(scope)
	pending := (*ref.pendingContexts)[sequence]
	pending.events = nil
	(*ref.pendingContexts)[sequence] = pending
	rt.eventBuffer.Clear()
	client.fakeClient.contextErr = errors.New("room context unavailable")
	rt.mu.Unlock()

	for range maxTurnRetryAttempts + 1 {
		rt.runTurn(scope, sequence)
	}
	blocked := waitForExecution(t, client, "req-T", "direct context retry exhaustion needs attention", func(p types.TaskExecutionProjection) bool {
		return p.Availability == types.TaskExecutionAvailabilityNeedsAttention && p.QueuedCount == 0
	})
	if blocked.Phase == types.TaskExecutionPhaseQueued || blocked.CurrentTurnSequence != 0 {
		t.Fatalf("closed direct-context retry was presented as lane contention: %+v", blocked)
	}

	rt.acceptEvent(scopedEvent(sequence+1, scope, "fresh Human instruction after context failure"))
	if got := adapter.runCount(scope); got != 0 {
		t.Fatalf("context-unavailable turn reached Harness unexpectedly: runs=%d", got)
	}
	client.fakeClient.mu.Lock()
	client.fakeClient.contextErr = nil
	client.fakeClient.mu.Unlock()
	adapter.releaseTurn()
	rt.drainTurns()
	if got := adapter.runCount(scope); got != 1 {
		t.Fatalf("fresh instruction did not escape the failed context state exactly once: runs=%d", got)
	}
	_, details := adapter.scopedRunSnapshot()
	if got := details[scope][0]; got != "fresh Human instruction after context failure" {
		t.Fatalf("discarded context failure leaked into the recovery turn: %q", got)
	}
}

func TestTaskExecutionPublicationIsBestEffort(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()
	client.mu.Lock()
	client.updateErr = errors.New("room rejected execution projection")
	client.mu.Unlock()

	// A failing execution publication must never affect the turn itself.
	drained := startTurn(rt, scopedEvent(70, "task:req-T", "instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	adapter.releaseTurn()
	waitForDone(t, drained, "turn to settle")
	if got := adapter.runCount("task:req-T"); got != 1 {
		t.Fatalf("an execution publication failure disturbed the turn: %d runs", got)
	}
	rt.mu.Lock()
	pending := 0
	if ref := rt.sessionRefLocked("task:req-T"); ref != nil && ref.pendingAddressed != nil {
		pending = len(*ref.pendingAddressed)
	}
	rt.mu.Unlock()
	if pending != 0 {
		t.Fatalf("a successful turn was not consumed: %d pending", pending)
	}
}

// freezeTaskExecutionPublisher stops the drain goroutine from consuming the
// newest-state queue, so a test can observe enqueues deterministically instead
// of racing publication.
func freezeTaskExecutionPublisher(rt *ResidentRuntime) {
	rt.taskExecutionPublishMu.Lock()
	rt.taskExecutionPublisherActive = true
	rt.taskExecutionPublishMu.Unlock()
}

// popTaskExecutionPublication removes and returns the queued projection for one
// scope, if any. Only valid while the publisher is frozen.
func popTaskExecutionPublication(
	rt *ResidentRuntime,
	scope string,
) (types.TaskExecutionProjection, bool) {
	rt.taskExecutionPublishMu.Lock()
	defer rt.taskExecutionPublishMu.Unlock()
	publication, ok := rt.taskExecutionPublishQueue[scope]
	if !ok {
		return types.TaskExecutionProjection{}, false
	}
	delete(rt.taskExecutionPublishQueue, scope)
	return publication.projection, true
}

// TestTaskExecutionLifecycleIsOwnedByTheTurnPipeline pins fix #1: the coarse
// activity helper must not own the Task execution lifecycle, and one canonical
// turn start must produce exactly one begin transition. The publisher is frozen
// so an enqueue is observable rather than hidden by latest-state coalescing.
func TestTaskExecutionLifecycleIsOwnedByTheTurnPipeline(t *testing.T) {
	rt, _, _ := newExecutionRuntime(t)
	defer rt.Stop()
	freezeTaskExecutionPublisher(rt)

	const scope = "task:req-T"

	// A previous intentional outcome must survive beginActivity untouched.
	rt.setTaskExecutionOutcome(scope, types.TaskExecutionOutcomeInterrupted)
	rt.beginActivity(scope, 5)
	if _, queued := popTaskExecutionPublication(rt, scope); queued {
		t.Fatal("beginActivity must not publish a Task execution projection")
	}
	rt.taskExecutionMu.Lock()
	outcome := rt.taskExecutionFacts[scope].lastOutcome
	rt.taskExecutionMu.Unlock()
	if outcome != types.TaskExecutionOutcomeInterrupted {
		t.Fatalf("beginActivity performed the execution begin transition: %+v", outcome)
	}

	// The serialized turn pipeline performs it, exactly once.
	rt.beginTaskTurn(scope, 5)
	begin, queued := popTaskExecutionPublication(rt, scope)
	if !queued {
		t.Fatal("the turn pipeline must publish the began turn")
	}
	if begin.CurrentTurnSequence != 5 || begin.Phase != types.TaskExecutionPhaseRunning {
		t.Fatalf("began-turn projection mismatch: %+v", begin)
	}
	if _, again := popTaskExecutionPublication(rt, scope); again {
		t.Fatal("one turn start must produce exactly one execution begin transition")
	}
	rt.taskExecutionMu.Lock()
	_, retained := rt.taskExecutionFacts[scope]
	rt.taskExecutionMu.Unlock()
	if retained {
		t.Fatal("beginTaskTurn must clear the previous outcome")
	}

	// The same holds through the real pipeline: one canonical turn start, on a
	// scope this test has not touched manually.
	rt.taskExecutionPublishMu.Lock()
	rt.taskExecutionPublisherActive = false
	rt.taskExecutionPublishMu.Unlock()
	const pipelineScope = "task:req-U"
	adapter := rt.options.Adapter.(*interruptAdapter)
	adapter.blockNextTurn()
	drained := startTurn(rt, scopedEvent(9, pipelineScope, "instruction"))
	waitFor(t, 2*time.Second, func() bool { return adapter.runCount(pipelineScope) >= 1 },
		"the canonical trigger to run")
	if got := adapter.runCount(pipelineScope); got != 1 {
		t.Fatalf("one trigger must run exactly once, got %d", got)
	}
	running, ok := rt.latestTaskExecution(pipelineScope)
	if !ok || running.CurrentTurnSequence != 9 || running.QueuedCount != 0 {
		t.Fatalf("real turn did not publish its running projection: %+v", running)
	}
	adapter.releaseTurn()
	waitForDone(t, drained, "turn to finish")
}

// latestTaskExecution reads the newest published projection for one scope from
// the frozen queue, or from a recording client otherwise.
func (r *ResidentRuntime) latestTaskExecution(scope string) (types.TaskExecutionProjection, bool) {
	return r.snapshotTaskExecution(scope)
}

// TestTaskExecutionSettlementNeverCountsTheFinishedTurnAsQueued pins fix #2 by
// stepping the real serialized pipeline with the publisher frozen: at no point
// may a settled projection report the turn that just stopped running as queued
// behind itself. Nothing here depends on publisher scheduling.
func TestTaskExecutionSettlementNeverCountsTheFinishedTurnAsQueued(t *testing.T) {
	const scope = "task:req-T"

	settled := func(t *testing.T, projection types.TaskExecutionProjection) {
		t.Helper()
		if projection.CurrentTurnSequence == 0 && projection.QueuedCount > 0 {
			// The only way a settled projection can be non-empty here is real
			// successor work; a self-count is the bug this test fences.
			if projection.QueuedCount == 1 && projection.LastOutcome == "" {
				t.Fatalf("settled projection counted the finished turn as queued: %+v", projection)
			}
		}
	}

	t.Run("successful single turn", func(t *testing.T) {
		rt, _, _ := newExecutionRuntime(t)
		defer rt.Stop()
		freezeTaskExecutionPublisher(rt)
		rt.acceptEvent(scopedEvent(42, scope, "instruction"))

		rt.beginActivity(scope, 42)
		rt.beginTaskTurn(scope, 42)
		if projection, ok := popTaskExecutionPublication(rt, scope); !ok ||
			projection.CurrentTurnSequence != 42 || projection.QueuedCount != 0 {
			t.Fatalf("running projection mismatch: %+v", projection)
		}

		// The successful settlement: finish, then acknowledge the trigger, then
		// refresh. The acknowledge must be what produces the settled state.
		rt.finishActivity(scope, 42)
		if projection, ok := popTaskExecutionPublication(rt, scope); ok {
			settled(t, projection)
			t.Fatalf("no settled projection may exist before the trigger is consumed: %+v", projection)
		}
		rt.acknowledgeHarnessDeliveryFor(scope, 42, 42, 0)
		projection, ok := popTaskExecutionPublication(rt, scope)
		if !ok {
			t.Fatal("consuming the trigger must refresh the settled projection")
		}
		settled(t, projection)
		if projection.CurrentTurnSequence != 0 || projection.QueuedCount != 0 {
			t.Fatalf("final projection mismatch: %+v", projection)
		}
	})

	t.Run("interrupted single turn", func(t *testing.T) {
		rt, _, _ := newExecutionRuntime(t)
		defer rt.Stop()
		freezeTaskExecutionPublisher(rt)
		rt.acceptEvent(scopedEvent(42, scope, "instruction"))

		rt.beginActivity(scope, 42)
		rt.beginTaskTurn(scope, 42)
		popTaskExecutionPublication(rt, scope)

		rt.markTurnInterruptedLocked(scope, 42)
		if !rt.consumeTurnInterrupted(scope, 42) {
			t.Fatal("the exact interrupted turn must be consumable")
		}
		rt.finishActivity(scope, 42)
		if projection, ok := popTaskExecutionPublication(rt, scope); ok {
			settled(t, projection)
			t.Fatalf("no settled projection may exist before the cancelled trigger is consumed: %+v", projection)
		}
		rt.settleInterruptedTurn(scope, 42, 42, 0, nil)

		projection, ok := popTaskExecutionPublication(rt, scope)
		if !ok {
			t.Fatal("the interrupted settlement must publish")
		}
		settled(t, projection)
		if projection.CurrentTurnSequence != 0 || projection.QueuedCount != 0 ||
			projection.LastOutcome != types.TaskExecutionOutcomeInterrupted {
			t.Fatalf("interrupted settlement mismatch: %+v", projection)
		}
	})

	t.Run("interrupted turn with a real successor", func(t *testing.T) {
		rt, _, _ := newExecutionRuntime(t)
		defer rt.Stop()
		freezeTaskExecutionPublisher(rt)
		rt.acceptEvent(scopedEvent(42, scope, "instruction"))
		// The successor is already durably queued behind the running turn.
		rt.acceptEvent(scopedEvent(43, scope, "replacement instruction"))

		rt.beginActivity(scope, 42)
		rt.beginTaskTurn(scope, 42)
		running, _ := popTaskExecutionPublication(rt, scope)
		if running.CurrentTurnSequence != 42 || running.QueuedCount != 1 {
			t.Fatalf("running-with-successor projection mismatch: %+v", running)
		}

		rt.markTurnInterruptedLocked(scope, 42)
		rt.consumeTurnInterrupted(scope, 42)
		rt.finishActivity(scope, 42)
		if projection, ok := popTaskExecutionPublication(rt, scope); ok {
			t.Fatalf("no settled projection may exist before the cancelled trigger is consumed: %+v", projection)
		}
		rt.settleInterruptedTurn(scope, 42, 42, 0, nil)

		afterCancel, ok := popTaskExecutionPublication(rt, scope)
		if !ok {
			t.Fatal("the interrupted settlement must publish")
		}
		settled(t, afterCancel)
		// Only the real successor 43 remains queued; 42 was consumed and is
		// never counted as its own successor.
		if afterCancel.CurrentTurnSequence != 0 || afterCancel.QueuedCount != 1 ||
			afterCancel.LastOutcome != types.TaskExecutionOutcomeInterrupted {
			t.Fatalf("post-interrupt queue projection mismatch: %+v", afterCancel)
		}

		// The successor then starts normally and is the only queued-then-running
		// work left.
		rt.beginActivity(scope, 43)
		rt.beginTaskTurn(scope, 43)
		successor, _ := popTaskExecutionPublication(rt, scope)
		if successor.CurrentTurnSequence != 43 || successor.QueuedCount != 0 ||
			successor.LastOutcome != "" {
			t.Fatalf("successor projection mismatch: %+v", successor)
		}
	})
}

// TestTaskExecutionRealTurnSettlementIsTruthful drives the REAL serialized
// pipeline for a single successful turn and asserts the delivered stream never
// presents the just-finished turn as queued behind itself.
func TestTaskExecutionRealTurnSettlementIsTruthful(t *testing.T) {
	rt, adapter, client := newExecutionRuntime(t)
	defer rt.Stop()

	drained := startTurn(rt, scopedEvent(42, "task:req-T", "instruction"))
	waitForActiveScope(t, rt, "task:req-T")
	adapter.releaseTurn()
	waitForDone(t, drained, "turn to settle")

	final := waitForExecution(t, client, "req-T", "settled projection", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 0 && p.QueuedCount == 0
	})
	if final.LastOutcome != "" || final.Availability != "" {
		t.Fatalf("a plain successful turn must settle without an outcome: %+v", final)
	}
	// Only projections emitted AFTER the running state can be settled states.
	// An instruction accepted while nothing runs is legitimately "Queued" for a
	// moment before the serialized drain starts it.
	client.mu.Lock()
	defer client.mu.Unlock()
	afterRunning := -1
	for index, projection := range client.projections {
		if projection.CurrentTurnSequence == 42 {
			afterRunning = index
			break
		}
	}
	if afterRunning < 0 {
		t.Fatalf("no running projection was published: %+v", client.projections)
	}
	for _, projection := range client.projections[afterRunning+1:] {
		if projection.CurrentTurnSequence != 0 {
			t.Fatalf("a second turn appeared for a single instruction: %+v", projection)
		}
		if projection.QueuedCount > 0 {
			t.Fatalf("a settled projection counted the finished turn as queued: %+v", projection)
		}
	}
}

func TestEmptySuccessfulHumanTaskPublishesCompletedLifecycle(t *testing.T) {
	client := newExecutionClient()
	adapter := &fakeAdapter{
		name:              "pi",
		scopedTurnResults: []types.HarnessTurnResult{{Text: ""}},
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "empty-task-result",
		RoomID:     "room-empty-task-result",
		Name:       "Pi",
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

	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-empty", "req-empty", "human-1")), "empty successful Task turn")
	results := client.fakeClient.snapshotCollabResults()
	if len(results) != 1 || results[0].RequestID != "req-empty" || results[0].Status != "completed" {
		t.Fatalf("an empty but successful final turn must settle its Human Task: %+v", results)
	}
}

func TestFinalHarnessFailureQuarantinesTaskForHumanRecovery(t *testing.T) {
	client := newExecutionClient()
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "failed-task-result",
		RoomID:     "room-failed-task-result",
		Name:       "Pi",
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
	rt.acceptEvent(taskRequestEvent(1, "task:req-failed", "req-failed", "human-1"))
	rt.failTurn("task:req-failed", 1, "harness", turnFailureOther, time.Now(), errors.New("final Harness failure"), false)

	results := client.fakeClient.snapshotCollabResults()
	if len(results) != 0 {
		t.Fatalf("an undelivered Harness instruction must remain recoverable, not terminally settled: %+v", results)
	}
	if got := rt.pendingAddressedSnapshotFor("task:req-failed"); len(got) != 0 {
		t.Fatalf("failed Task work was left as queue contention: %v", got)
	}
	projection, ok := rt.snapshotTaskExecution("task:req-failed")
	if !ok || projection.Availability != types.TaskExecutionAvailabilityNeedsAttention {
		t.Fatalf("failed Task should require Human attention: %+v, ok=%v", projection, ok)
	}
}

func TestNewHumanInstructionRecoversUnacceptedTaskRequestWithoutReplayingItsContent(t *testing.T) {
	client := newExecutionClient()
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "unaccepted-task-recovery",
		RoomID:     "room-unaccepted-task-recovery",
		Name:       "Pi",
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

	const scope = "task:req-recover"
	initial := taskRequestEvent(1, scope, "req-recover", "human-1")
	initial.Collab.Summary = "private initial summary"
	initial.Collab.Details = map[string]string{"task": "private initial details"}
	rt.acceptEvent(initial)
	// Fail before Harness admission/acceptance. The new Human instruction must
	// be able to resume the canonical Task without retaining or replaying this
	// prompt as Runtime-owned execution work.
	rt.failTurn(scope, 1, "harness", turnFailureSession, time.Now(), errScopedHarnessUnsupported, false)
	if got := rt.pendingAddressedSnapshotFor(scope); len(got) != 0 {
		t.Fatalf("unaccepted initial request remained as queue contention: %v", got)
	}

	waitForDone(t, startTurn(rt, scopedEvent(2, scope, "fresh Human instruction C")), "fresh Human recovery instruction")
	responses := client.snapshotCollabResponses()
	if len(responses) != 1 || responses[0].RequestID != "req-recover" {
		t.Fatalf("recovery did not accept the canonical Task exactly once: %+v", responses)
	}
	_, contexts := adapter.scopedRunSnapshot()
	if got := contexts[scope]; len(got) != 1 || got[0] != "fresh Human instruction C" {
		t.Fatalf("recovery replayed old Task content instead of only C: %v", got)
	}
}

func TestTerminalTaskFailureCannotBeReopenedBySameScopeTrigger(t *testing.T) {
	client := newExecutionClient()
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "terminal-task-failure",
		RoomID:     "room-terminal-task-failure",
		Name:       "Pi",
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

	rt.acceptEvent(taskRequestEvent(1, "task:req-shared", "req-terminal", "human-1"))
	rt.failTurn("task:req-shared", 1, "harness", turnFailureOther, time.Now(), errors.New("permanent Harness failure"), false)
	if pending := rt.pendingAddressedSnapshotFor("task:req-shared"); len(pending) != 0 {
		t.Fatalf("failed Task work remained as queue contention: %v", pending)
	}
	results := client.fakeClient.snapshotCollabResults()
	if len(results) != 0 {
		t.Fatalf("undelivered work must not be falsely terminally settled: %+v", results)
	}

	// A later request in the same Task scope is new work. It must not replay the
	// already-failed canonical trigger or issue a contradictory completion for
	// req-terminal.
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-shared", "req-new", "human-1")), "new Task trigger after terminal failure")
	results = client.fakeClient.snapshotCollabResults()
	if len(results) != 1 || results[0].RequestID != "req-new" || results[0].Status != "completed" {
		t.Fatalf("later same-scope work did not recover normally: %+v", results)
	}
}

func TestHarnessReplySendFailurePublishesOneTaskSettlement(t *testing.T) {
	client := newExecutionClient()
	client.fakeClient.sendFailuresRemaining = 1
	adapter := &fakeAdapter{
		name:              "pi",
		scopedTurnResults: []types.HarnessTurnResult{{Text: "completed work"}},
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "send-failure-single-settlement",
		RoomID:     "room-send-failure-single-settlement",
		Name:       "Pi",
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

	waitForDone(t, startTurn(rt, taskRequestEvent(1, "task:req-send-failure", "req-send-failure", "human-1")), "failed Task reply delivery")
	results := client.fakeClient.snapshotCollabResults()
	if len(results) != 1 || results[0].RequestID != "req-send-failure" || results[0].Status != "failed" {
		t.Fatalf("the RunTurn-success/SendText-failure path must publish exactly one terminal result: %+v", results)
	}
}

func TestExecutorLossSettlesCurrentHumanTaskAsFailed(t *testing.T) {
	client := newExecutionClient()
	gate := make(chan struct{})
	adapter := &fakeAdapter{name: "pi", scopedTurnWait: gate}
	rt := NewResidentRuntime(Options{
		InstanceID: "executor-loss-task",
		RoomID:     "room-executor-loss-task",
		Name:       "Pi",
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

	done := startTurn(rt, taskRequestEvent(1, "task:req-lost", "req-lost", "human-1"))
	waitForActiveScope(t, rt, "task:req-lost")
	adapter.fireFailure(errors.New("provider process exited"))
	results := client.fakeClient.snapshotCollabResults()
	if len(results) != 1 || results[0].RequestID != "req-lost" || results[0].Status != "failed" {
		t.Fatalf("executor loss left its active Task without a terminal result: %+v", results)
	}
	close(gate)
	waitForDone(t, done, "executor loss turn cleanup")
}

// TestQueuedProjectionCountsOnlyUndeliveredWork is the #484 P2 regression: a
// steered instruction delivered out of canonical order is no longer queued
// work, even though it legitimately stays in the canonical ledger until the
// earlier gap collapses.
//
//	A active, B queued, C steered and already delivered into A
//	-> QueuedCount must count B only (1), not the raw ledger length (2).
func TestQueuedProjectionCountsOnlyUndeliveredWork(t *testing.T) {
	const scope = "task:req-T"
	adapter := &nativeSteerAdapter{interruptAdapter: newInterruptAdapter()}
	client := newExecutionClient()
	rt := NewResidentRuntime(Options{
		InstanceID: "steer-queued",
		RoomID:     "room-steer-queued",
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
	t.Cleanup(rt.Stop) // LIFO: the adapter releases parked turns first.
	t.Cleanup(adapter.releaseAllTurns)

	hold := adapter.holdTurns()
	drained := startTurn(rt, scopedEvent(1, scope, "A"))
	waitForActiveScope(t, rt, scope)
	rt.acceptEvent(scopedEvent(2, scope, "B"))
	rt.acceptEvent(scopedEvent(3, scope, "C"))
	waitForExecution(t, client, "req-T", "running turn with two waiting instructions", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 1 && p.QueuedCount == 2
	})

	// C is steered and the Harness confirms it reached the ACTIVE turn, so it
	// is delivered out of canonical order and A keeps running.
	rt.applyResidentTaskControl(steerControl("req-T", 1, 3))
	if got := adapter.steeredTexts(); !reflect.DeepEqual(got, []string{"task:req-T@1=C"}) {
		t.Fatalf("native steer delivery mismatch: %v", got)
	}
	adapter.releaseTurn() // A keeps running on the hold channel.

	// Truth: only B is still waiting. The delivered C is retained in the
	// canonical ledger behind the A/B gap and must NOT be reported as queued.
	waitForExecution(t, client, "req-T", "running turn with one undelivered successor", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 1 && p.QueuedCount == 1
	})
	if got := rt.pendingAddressedSnapshotFor(scope); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
		t.Fatalf("canonical ledger changed under an out-of-order delivery: %v", got)
	}
	if steerStillUndelivered(rt, scope, 3) {
		t.Fatal("the steered instruction was not recorded as delivered")
	}
	// The delivery cursor must not have jumped over the undelivered B.
	if got := rt.deliveredSeqFor(scope); got != 0 {
		t.Fatalf("cursor advanced past undelivered work: %d", got)
	}

	// A finishes, B drains, and only then does the canonical prefix collapse.
	close(hold)
	waitForDone(t, drained, "steered Task to drain")
	waitForExecution(t, client, "req-T", "settled projection with no reported work", func(p types.TaskExecutionProjection) bool {
		return p.CurrentTurnSequence == 0 && p.QueuedCount == 0
	})
	if got := rt.pendingAddressedSnapshotFor(scope); len(got) != 0 {
		t.Fatalf("a delivered steer stayed in the canonical ledger: %v", got)
	}
	if got := rt.deliveredSeqFor(scope); got != 3 {
		t.Fatalf("delivery cursor = %d, want the collapsed canonical prefix", got)
	}
}
