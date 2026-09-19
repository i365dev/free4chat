package runtime

import (
	"errors"
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

	// Task U owns the single global Harness turn.
	startTurn(rt, scopedEvent(20, "task:req-U", "U instruction"))
	waitForActiveScope(t, rt, "task:req-U")

	// Task T has no current turn but one accepted instruction waiting.
	rt.acceptEvent(scopedEvent(21, "task:req-T", "T instruction"))
	queued := waitForExecution(t, client, "req-T", "queued Task projection", func(p types.TaskExecutionProjection) bool {
		return p.QueuedCount == 1
	})
	if queued.CurrentTurnSequence != 0 || queued.Phase != "" {
		t.Fatalf("a Task behind another Task claimed a current turn: %+v", queued)
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
	retryPlan := rt.turnRetryPlan
	retryAttempt := rt.turnRetryAttempt
	pending := 0
	if ref := rt.sessionRefLocked("task:req-T"); ref != nil && ref.pendingAddressed != nil {
		pending = len(*ref.pendingAddressed)
	}
	rt.mu.Unlock()
	if retryPlan != nil || retryAttempt != 0 {
		t.Fatalf("an interrupted turn armed autonomous retry: plan=%v attempt=%d", retryPlan, retryAttempt)
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
