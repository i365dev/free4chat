package runtime

import (
	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Transient Task execution projection (#409).
 *
 * This is ONE small Runtime-authoritative projection, not a second state
 * machine. It is derived from facts the Runtime already owns:
 *
 *   queuedCount  <- the existing serial pendingAddressed list of that scope
 *   currentTurn  <- the existing exact-turn identity (scope + canonical Room
 *                   sequence) that #414 already uses for remote interrupt
 *   phase        <- whether an authorized interrupt was dispatched for that
 *                   same exact turn
 *   lastOutcome  <- whether that exact turn settled after a Human interrupt
 *   availability <- whether the retained Harness session for the Task died
 *
 * The retained Task lifecycle (Starting|Working|Completed|Failed) and the
 * coarse Harness activity (working|thinking|using_tools|responding) stay
 * exactly as they are: execution owns control truth only, and "running with N
 * queued" is one state rather than an enum value.
 *
 * There is no TaskQueue here: the Runtime's existing serialized pending-turn
 * model IS the queue. Nothing in this file schedules, retries, or reorders
 * Harness work.
 *
 * Publication mirrors activity publication: a newest-state queue per scope
 * drained by one goroutine, so Room HTTP I/O never happens while Runtime state
 * locks are held, and a slow/throttled Room can never block a turn.
 */

// taskExecutionFacts are the only execution facts that cannot be derived from
// the pending queue or the active-turn identity.
type taskExecutionFacts struct {
	lastOutcome  types.TaskExecutionOutcome
	availability types.TaskExecutionAvailability
}

type taskExecutionPublication struct {
	handle     string
	projection types.TaskExecutionProjection
}

// taskExecutionScope reports whether this logical scope is a Task scope whose
// execution is worth projecting.
func taskExecutionScope(scope string) bool {
	return taskRequestIDForScope(scope) != ""
}

// snapshotTaskExecution derives the projection for one Task scope from the
// authoritative Runtime facts. It never invents a turn identity, a queue depth,
// or an outcome.
func (r *ResidentRuntime) snapshotTaskExecution(scope string) (types.TaskExecutionProjection, bool) {
	requestID := taskRequestIDForScope(scope)
	if requestID == "" || len(requestID) > types.MaxResidentTaskRequestID {
		return types.TaskExecutionProjection{}, false
	}

	// Current exact turn + interrupt phase. Lock order follows the documented
	// turnControlMu -> activityMu discipline; every lock is released before the
	// next section so no other order is ever introduced.
	r.turnControlMu.Lock()
	r.activityMu.Lock()
	active := r.activityTurnActive && r.activityScope == scope
	currentTurn := int64(0)
	if active {
		currentTurn = r.activityTurnSequence
	}
	interrupting := active && r.interruptScope == scope && r.interruptTarget == currentTurn
	r.activityMu.Unlock()
	r.turnControlMu.Unlock()

	// Queue depth: the existing serial pending list. The turn that is running
	// right now is still the head of that list, so it is not "queued".
	r.mu.Lock()
	queued := 0
	if ref := r.sessionRefLocked(scope); ref != nil && ref.pendingAddressed != nil {
		queued = len(*ref.pendingAddressed)
	}
	r.mu.Unlock()
	if active && queued > 0 {
		queued--
	}

	r.taskExecutionMu.Lock()
	facts := r.taskExecutionFacts[scope]
	r.taskExecutionMu.Unlock()

	projection := types.TaskExecutionProjection{
		TaskRequestID:       requestID,
		CurrentTurnSequence: currentTurn,
		QueuedCount:         queued,
		LastOutcome:         facts.lastOutcome,
		Availability:        facts.availability,
	}
	if currentTurn > 0 {
		projection.Phase = types.TaskExecutionPhaseRunning
		if interrupting {
			projection.Phase = types.TaskExecutionPhaseInterrupting
		}
	}
	// A turn that is running right now is no longer "interrupted", and a lost
	// session is superseded by the turn that just started on a fresh one.
	if active {
		projection.LastOutcome = ""
	}
	return projection, projection.Valid()
}

// publishTaskExecution enqueues the newest projection for one Task scope. It is
// called from the serialized turn path and from the resident reader, so it must
// never wait for Room I/O.
func (r *ResidentRuntime) publishTaskExecution(scope string) {
	scope = normalizeScope(scope)
	if !taskExecutionScope(scope) {
		return
	}
	projection, ok := r.snapshotTaskExecution(scope)
	if !ok {
		return
	}
	handle := r.currentHandle()
	if handle == "" {
		return
	}
	r.taskExecutionPublishMu.Lock()
	if r.taskExecutionPublishQueue == nil {
		r.taskExecutionPublishQueue = make(map[string]taskExecutionPublication)
	}
	r.taskExecutionPublishQueue[scope] = taskExecutionPublication{
		handle:     handle,
		projection: projection,
	}
	if r.taskExecutionPublisherActive {
		r.taskExecutionPublishMu.Unlock()
		return
	}
	r.taskExecutionPublisherActive = true
	r.taskExecutionPublishMu.Unlock()
	go r.drainTaskExecutionPublications()
}

// drainTaskExecutionPublications is the same single-sender, latest-state design
// as activity publication: order within a scope is preserved, an in-flight
// older state cannot be overtaken by a newer queued one, and no goroutine is
// created per update.
func (r *ResidentRuntime) drainTaskExecutionPublications() {
	for {
		r.taskExecutionPublishMu.Lock()
		if len(r.taskExecutionPublishQueue) == 0 {
			r.taskExecutionPublisherActive = false
			r.taskExecutionPublishMu.Unlock()
			return
		}
		var scope string
		var publication taskExecutionPublication
		for queuedScope, queuedPublication := range r.taskExecutionPublishQueue {
			scope, publication = queuedScope, queuedPublication
			break
		}
		delete(r.taskExecutionPublishQueue, scope)
		r.taskExecutionPublishMu.Unlock()
		r.publishTaskExecutionNow(publication)
	}
}

func (r *ResidentRuntime) publishTaskExecutionNow(publication taskExecutionPublication) {
	client, ok := r.options.Client.(types.ResidentTaskExecutionClient)
	if !ok {
		return
	}
	if err := client.UpdateTaskExecution(publication.handle, publication.projection); err != nil {
		// Best-effort presentation only: a Room that cannot record execution
		// state must never affect the turn, the queue, or the session.
		r.log("task_execution_update_failed", map[string]string{
			"reason": string(free4chat.CodeOf(err)),
		})
	}
}

// beginTaskTurn records the transient execution facts of a turn that is
// starting: the exact turn is current, and a previous interrupted outcome or
// lost-session availability no longer describes this Task.
func (r *ResidentRuntime) beginTaskTurn(scope string, turnSequence int64) {
	if !taskExecutionScope(scope) || turnSequence <= 0 {
		return
	}
	r.taskExecutionMu.Lock()
	delete(r.taskExecutionFacts, scope)
	r.taskExecutionMu.Unlock()
	r.publishTaskExecution(scope)
}

// finishTaskTurn records the settlement of one exact turn. An intentionally
// interrupted turn keeps that outcome until a new instruction or turn replaces
// it; any other settlement simply drops the current-turn presentation.
func (r *ResidentRuntime) finishTaskTurn(scope string, turnSequence int64, interrupted bool) {
	if !taskExecutionScope(scope) {
		return
	}
	if interrupted {
		r.setTaskExecutionOutcome(scope, types.TaskExecutionOutcomeInterrupted)
	}
	r.publishTaskExecution(scope)
}

// noteTaskQueueChanged republishes a Task's execution after its pending queue
// changed (an instruction was accepted, consumed, or discarded).
func (r *ResidentRuntime) noteTaskQueueChanged(scope string) {
	if !taskExecutionScope(scope) {
		return
	}
	// A newly accepted instruction ends the previous "Interrupted" presentation
	// for that Task: the Human has already moved on.
	r.clearTaskExecutionOutcome(scope)
	r.publishTaskExecution(scope)
}

func (r *ResidentRuntime) setTaskExecutionOutcome(scope string, outcome types.TaskExecutionOutcome) {
	if !taskExecutionScope(scope) {
		return
	}
	r.taskExecutionMu.Lock()
	facts := r.taskExecutionFacts[scope]
	facts.lastOutcome = outcome
	r.taskExecutionFacts[scope] = facts
	r.taskExecutionMu.Unlock()
}

func (r *ResidentRuntime) clearTaskExecutionOutcome(scope string) {
	r.taskExecutionMu.Lock()
	if facts, ok := r.taskExecutionFacts[scope]; ok {
		facts.lastOutcome = ""
		r.taskExecutionFacts[scope] = facts
	}
	r.taskExecutionMu.Unlock()
}

// noteTaskSessionLoss publishes the truthful availability of every Task whose
// retained Harness session just died unexpectedly. It is called from the
// adapter failure boundary only: a Room or resident transport reconnect is NOT
// a Harness session loss.
func (r *ResidentRuntime) noteTaskSessionLoss() {
	if r.isStopped() {
		return
	}
	r.mu.Lock()
	scopes := make([]string, 0, len(r.scopeOrder))
	for _, scope := range r.scopeOrder {
		if !taskExecutionScope(scope) {
			continue
		}
		state := r.scopedSessions[scope]
		if state == nil {
			continue
		}
		// Only a Task that actually had a retained Harness conversation can
		// lose one.
		if state.observedHarnessGeneration <= 0 && state.bootstrappedHarnessGeneration <= 0 {
			continue
		}
		scopes = append(scopes, scope)
	}
	r.mu.Unlock()

	for _, scope := range scopes {
		r.taskExecutionMu.Lock()
		r.taskExecutionFacts[scope] = taskExecutionFacts{
			availability: types.TaskExecutionAvailabilitySessionLost,
		}
		r.taskExecutionMu.Unlock()
		r.publishTaskExecution(scope)
	}
}

// clearTaskExecutionLocal drops all transient execution facts. It is used on
// stop and on an unexpected Harness failure that already published its own
// availability, so no stale outcome can outlive the Runtime state it described.
func (r *ResidentRuntime) clearTaskExecutionLocal() {
	r.taskExecutionMu.Lock()
	r.taskExecutionFacts = make(map[string]taskExecutionFacts)
	r.taskExecutionMu.Unlock()
}

// markTurnInterruptedLocked records that a Human interrupt was authorized and
// dispatched for this exact canonical turn. Callers must hold turnControlMu, so
// the marker can never be observed by a different turn than the one that was
// checked.
func (r *ResidentRuntime) markTurnInterruptedLocked(scope string, turnSequence int64) {
	r.activityMu.Lock()
	r.interruptScope = scope
	r.interruptTarget = turnSequence
	r.activityMu.Unlock()
}

// clearTurnInterruptedActivityLocked drops the marker for one exact turn.
// Callers must hold turnControlMu AND activityMu (it is the inner variant used
// by callers that already own both, so it never re-locks).
func (r *ResidentRuntime) clearTurnInterruptedActivityLocked(scope string, turnSequence int64) {
	if r.interruptScope == scope && r.interruptTarget == turnSequence {
		r.interruptScope = ""
		r.interruptTarget = 0
	}
}

// consumeTurnInterrupted reports whether THIS exact turn was intentionally
// interrupted, and clears the marker. It is consumed exactly once, by the
// settlement of that same (scope, canonical sequence) turn.
func (r *ResidentRuntime) consumeTurnInterrupted(scope string, turnSequence int64) bool {
	r.turnControlMu.Lock()
	defer r.turnControlMu.Unlock()
	r.activityMu.Lock()
	interrupted := r.interruptScope == scope && r.interruptTarget == turnSequence
	if interrupted {
		r.clearTurnInterruptedActivityLocked(scope, turnSequence)
	}
	r.activityMu.Unlock()
	return interrupted
}

// settleInterruptedTurn consumes an intentionally interrupted canonical turn.
//
// WHY THIS IS A TERMINAL SETTLEMENT AND NOT A HARNESS FAILURE: the Human asked
// Free4Chat to stop exactly this trigger, so replaying it would contradict an
// explicit Human instruction and re-run cognition they cancelled. The bounded
// autonomous retry budget exists for transport/Harness failures nobody asked
// for, so it is deliberately NOT used here; the retry bookkeeping for this
// (scope, target) is cleared instead.
//
// The trigger is acknowledged at the same Harness-delivery boundary a
// successful turn uses. That both removes it from the existing serial pending
// queue and advances the delivered cursor, so the cancelled instruction can
// never reappear in a later turn's context. No parallel delivered cursor is
// introduced.
//
// Whatever the cancelled Harness call returned is dropped: a cancelled turn's
// tail text is not an Agent reply the Human asked for. Only bounded,
// content-free diagnostics are logged.
func (r *ResidentRuntime) settleInterruptedTurn(scope string, target, through, generation int64, turnErr error) {
	if through <= 0 {
		through = target
	}
	r.acknowledgeHarnessDeliveryFor(scope, target, through, generation)
	r.clearTurnRetry(scope, target)
	reason := "cancelled"
	if turnErr != nil {
		// The cancelled turn may also have surfaced a real transport/Harness
		// failure. That is reported through the adapter's own failure boundary
		// (which publishes a lost session), never as an autonomous retry of a
		// turn the Human stopped.
		reason = turnFailureClassOf(turnErr)
	}
	r.log("task_interrupt_settled", map[string]string{
		"scopeKind":    scopeKindOf(scope),
		"failureClass": reason,
	})
}
