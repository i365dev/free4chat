package runtime

import (
	"strconv"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task-scoped remote supervision (#409, #484).
 *
 * Two semantics share one private control frame, and they are deliberately
 * different operations:
 *
 *	Interrupt  = best-effort request for exactly that scope's active turn to
 *	             stop or yield. It is NOT a promise that Free4Chat
 *	             synchronously terminates Harness-owned tool work, and it is
 *	             never provider recovery.
 *	Steer      = make an already-accepted canonical Human instruction affect
 *	             that scope's work before ordinary queued follow-ups. It does
 *	             not depend on a successful cancel.
 *
 * Both are exact to ONE turn: a Task scope alone is NOT turn identity, because
 * the same Task runs many turns and matching only the scope would let a delayed
 * or stale control stop or redirect a later turn. Turn identity is the
 * canonical addressed Room sequence the Runtime already received as `target` at
 * the serialized admission boundary.
 *
 * It is NOT: Task deletion, leaving the Room, killing the Runtime or the
 * Harness process, clearing Task history, or cancelling another client's turn.
 * The Runtime never trusts the control by itself — authorization comes from the
 * turn it already owns.
 *
 * A control with no matching active turn is a local no-op. It is never retained
 * as a pending intent, because a stale button click must never be able to stop
 * or redirect a future turn that happens to reuse the same Task scope.
 */

// applyResidentTaskControl handles one private resident control frame. It is
// called from the resident event loop and never from the human/Room path.
func (r *ResidentRuntime) applyResidentTaskControl(control *types.ResidentTaskControl) {
	if control == nil {
		return
	}
	switch control.Kind {
	case types.ResidentTaskControlInterrupt:
		r.applyResidentTaskInterrupt(control)
	case types.ResidentTaskControlSteer:
		r.applyResidentTaskSteer(control)
	}
}

// applyResidentTaskInterrupt is the plain Human Interrupt: ask exactly the turn
// the Human saw running to stop or yield. It is best-effort by contract — the
// Runtime marks the turn as interrupt-requested only when the dispatch really
// happened, and the turn's own settlement remains the only thing that ends it.
func (r *ResidentRuntime) applyResidentTaskInterrupt(control *types.ResidentTaskControl) {
	requestedScope := taskScopeForRequestID(control.TaskRequestID)
	if requestedScope == "" ||
		control.TurnSequence <= 0 ||
		control.TurnSequence > types.MaxResidentTurnSequence {
		return
	}
	if !r.cancelActiveTaskTurn(requestedScope, control.TurnSequence) {
		// Stale, duplicated, another Task, or another turn of the same Task:
		// report the bounded outcome and change nothing.
		r.log("task_interrupt_ignored", map[string]string{"scopeKind": scopeKindOf(requestedScope)})
		return
	}
	// The dispatch succeeded, so this exact turn is now truthfully
	// "interrupting" (until it settles). Published outside turnControlMu: the
	// projection snapshot takes that same lock.
	r.publishTaskExecution(requestedScope)
	r.log("task_interrupt_requested", map[string]string{"scopeKind": scopeKindOf(requestedScope)})
}

// applyResidentTaskSteer is STEER (#484). The Room already accepted the Human's
// replacement instruction as canonical Task input and named it here by
// sequence; this makes that SAME canonical instruction take priority over
// ordinary queued follow-ups, and only then asks the current turn to yield.
//
// Order matters and is the product guarantee:
//
//  1. a proven native Harness steering path is tried first, because injecting
//     the guidance into the live turn changes what the Agent does next without
//     giving up any work;
//  2. otherwise the instruction becomes the next not-yet-started instruction of
//     this Task, so it is preserved no matter how cancellation behaves;
//  3. only then is the exact turn asked to yield, best-effort.
//
// The instruction is therefore never lost when cancel is slow, ignored, or
// cannot be written: cancel only decides how soon the steer runs, never
// whether it survives.
func (r *ResidentRuntime) applyResidentTaskSteer(control *types.ResidentTaskControl) {
	requestedScope := taskScopeForRequestID(control.TaskRequestID)
	if requestedScope == "" ||
		control.TurnSequence <= 0 ||
		control.TurnSequence > types.MaxResidentTurnSequence ||
		control.SteerInstructionSequence <= 0 ||
		control.SteerInstructionSequence > types.MaxResidentTurnSequence {
		return
	}
	// Steer authority is the same exact-turn authority as cancel: only the turn
	// the Human was actually looking at may be steered, so a stale control can
	// never redirect a successor turn.
	if !r.turnControlAuthorized(requestedScope, control.TurnSequence) {
		r.log("task_steer_ignored", map[string]string{"scopeKind": scopeKindOf(requestedScope)})
		return
	}
	// The instruction must still be pending work. A control that names an
	// instruction this Runtime already delivered (or refused) has nothing left
	// to steer and must not cancel the current turn for nothing.
	if !r.steerInstructionPending(requestedScope, control.SteerInstructionSequence) {
		r.log("task_steer_ignored", map[string]string{"scopeKind": scopeKindOf(requestedScope)})
		return
	}
	if r.deliverNativeSteer(requestedScope, control.SteerInstructionSequence) {
		r.log("task_steer_native_delivered", map[string]string{"scopeKind": scopeKindOf(requestedScope)})
		return
	}
	// Fallback: preserve first, then ask the turn to yield. Promotion is done
	// before the cancel dispatch so the steer is already the priority-next
	// instruction when that turn settles, however it settles.
	promotion := r.promoteSteerPending(requestedScope, control.SteerInstructionSequence)
	if promotion == steerPromotionMissing {
		// The turn settled between the check above and this decision, so its
		// successor already consumed the instruction: nothing to promote and
		// nothing to interrupt.
		r.log("task_steer_ignored", map[string]string{"scopeKind": scopeKindOf(requestedScope)})
		return
	}
	cancelled := r.cancelActiveTaskTurn(requestedScope, control.TurnSequence)
	if cancelled {
		r.publishTaskExecution(requestedScope)
	}
	r.log("task_steer_fallback", map[string]string{
		"scopeKind": scopeKindOf(requestedScope),
		"promoted":  strconv.FormatBool(promotion == steerPromotionMoved),
		"cancel":    strconv.FormatBool(cancelled),
	})
}

// steerInstructionPending reports whether this canonical instruction is still
// waiting to be delivered for that Task.
func (r *ResidentRuntime) steerInstructionPending(scope string, sequence int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil || ref.pendingAddressed == nil {
		return false
	}
	return containsSequence(*ref.pendingAddressed, sequence)
}

// turnControlAuthorized reports whether this exact canonical turn is still the
// active turn of that scope. It is the read-only half of the cancel authority
// and is used where a control must be validated before any other effect.
func (r *ResidentRuntime) turnControlAuthorized(scope string, turnSequence int64) bool {
	r.turnControlMu.Lock()
	defer r.turnControlMu.Unlock()
	r.activityMu.Lock()
	defer r.activityMu.Unlock()
	current, active := r.activities[scope]
	return active && current.sequence == turnSequence
}

// promoteSteerPending marks the canonical steer instruction as priority-next
// for its Task inside the existing bounded pending state.
func (r *ResidentRuntime) promoteSteerPending(scope string, sequence int64) steerPromotion {
	r.mu.Lock()
	promotion := r.promoteSteerPendingLocked(scope, sequence)
	r.mu.Unlock()
	return promotion
}

// deliverNativeSteer attempts the provider-neutral native steering seam. It
// reports true only when the Harness confirms the guidance really reached the
// active turn; in that case the canonical instruction is acknowledged exactly
// once so it can never also run as its own queued turn.
//
// A Harness without a proven native path simply does not implement the seam,
// which is the common case today: no current pinned bridge exposes one. Nothing
// here branches on a provider name, and a bridge's wire spelling is never
// visible above the adapter.
func (r *ResidentRuntime) deliverNativeSteer(scope string, steerSequence int64) bool {
	steerer, ok := r.options.Adapter.(types.ScopedTurnSteerer)
	if !ok {
		return false
	}
	events, err := r.pendingContextFor(scope, steerSequence)
	if err != nil || len(events) == 0 {
		return false
	}
	input := BuildHarnessTurn(events, &TurnContextOptions{
		Self:          r.selfContext(),
		Participants:  r.rosterSnapshot(),
		TaskRequestID: taskRequestIDForScope(scope),
	})
	if err := steerer.SteerTurnFor(scope, *input); err != nil {
		return false
	}
	// The active turn consumed this exact canonical instruction, so it is
	// delivered: advance the delivery boundary and drop the queued trigger
	// exactly once. A later successor turn therefore never replays it.
	generation, generationErr := r.harnessSessionGeneration(scope)
	if generationErr != nil {
		generation = 0
	}
	r.acknowledgeHarnessDeliveryFor(scope, steerSequence, steerSequence, generation)
	return true
}

// taskScopeForRequestID builds the exact logical scope for one Task id. It
// reuses the same admission predicate as activity publication, so an interrupt
// can only ever name a scope this Runtime could actually be running, and it
// normalizes nothing: a padded or malformed id yields no scope at all.
func taskScopeForRequestID(taskRequestID string) string {
	if taskRequestID == "" || strings.ContainsAny(taskRequestID, " \t\r\n") {
		return ""
	}
	scope := "task:" + taskRequestID
	if !validActivityScope(scope) {
		return ""
	}
	return scope
}

// cancelActiveTaskTurn is the authority boundary. It requires the exact active
// turn — same Task scope AND same canonical trigger sequence — and it holds
// turnControlMu across both the check and the CancelTurn() dispatch.
//
// That mutual exclusion with beginActivity/finishActivity is what closes the
// TOCTOU window: while this dispatch is in flight the old turn cannot complete
// its active->idle transition, and no successor turn can become active. A
// control that arrives after the transition observes a different (or cleared)
// turn identity and is a no-op.
//
// #421 makes the dispatch scope-exact rather than implicitly single-prompt:
// the Runtime names the logical scope whose turn it proved it owns, and the
// adapter cancels the one conversation that scope is bound to. An adapter that
// cannot cancel by scope keeps the legacy whole-adapter cancel, which stays
// correct for a serial adapter because at most one turn is in flight there.
func (r *ResidentRuntime) cancelActiveTaskTurn(scope string, turnSequence int64) bool {
	if r.options.Adapter == nil {
		return false
	}
	r.turnControlMu.Lock()
	defer r.turnControlMu.Unlock()

	r.activityMu.Lock()
	current, active := r.activities[scope]
	authorized := active && current.sequence == turnSequence
	// activityMu is released before the adapter call: a cancellation may cause
	// the Harness to emit a final activity update, which re-enters this Runtime
	// through observeHarnessActivity and must not deadlock here. turnControlMu
	// stays held, which is what makes the check-and-dispatch atomic.
	r.activityMu.Unlock()
	if !authorized {
		return false
	}
	if err := r.cancelHarnessTurnFor(scope); err != nil {
		// The dispatch did not land, so nothing was interrupted: do not claim
		// an interrupting phase, and do not mark the turn as intentionally
		// stopped.
		r.log("task_interrupt_cancel_failed", map[string]string{"scopeKind": scopeKindOf(scope)})
		return false
	}
	// Marked while the exact-turn check and the dispatch are still atomic with
	// respect to begin/finish transitions, so the marker can only ever be
	// consumed by THIS turn's settlement.
	r.markTurnInterruptedLocked(scope, turnSequence)
	return true
}

// cancelHarnessTurnFor dispatches the exact-conversation cancel for one scope.
// The optional scoped seam is preferred; a serial adapter without it can only
// ever have one in-flight turn, so its whole-adapter cancel is still exact.
func (r *ResidentRuntime) cancelHarnessTurnFor(scope string) error {
	if adapter, ok := r.options.Adapter.(types.ScopedTurnCanceller); ok {
		return adapter.CancelTurnFor(scope)
	}
	return r.options.Adapter.CancelTurn()
}
