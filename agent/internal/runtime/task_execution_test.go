package runtime

import (
	"errors"
	"reflect"
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

func TestFinalHarnessFailureSettlesHumanTaskAsFailed(t *testing.T) {
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
	if len(results) != 1 || results[0].RequestID != "req-failed" || results[0].Status != "failed" {
		t.Fatalf("a final Harness failure must settle its Human Task: %+v", results)
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
		t.Fatalf("terminal Task failure remained reopenable: %v", pending)
	}
	results := client.fakeClient.snapshotCollabResults()
	if len(results) != 1 || results[0].RequestID != "req-terminal" || results[0].Status != "failed" {
		t.Fatalf("terminal failure did not publish exactly one failed result: %+v", results)
	}

	// A later request in the same Task scope is new work. It must not replay the
	// already-failed canonical trigger or issue a contradictory completion for
	// req-terminal.
	waitForDone(t, startTurn(rt, taskRequestEvent(2, "task:req-shared", "req-new", "human-1")), "new Task trigger after terminal failure")
	results = client.fakeClient.snapshotCollabResults()
	if len(results) != 2 || results[0].RequestID != "req-terminal" || results[0].Status != "failed" ||
		results[1].RequestID != "req-new" || results[1].Status != "completed" {
		t.Fatalf("later same-scope work contradicted the terminal Task outcome: %+v", results)
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
