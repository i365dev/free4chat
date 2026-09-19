package runtime

import (
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Task-scoped remote interrupt (#409).
 *
 * This is deliberately the narrowest possible seam: a Human clicking
 * Interrupt in the Room must cancel only the Harness turn the resident
 * Runtime CURRENTLY owns for exactly that Task.
 *
 *	Free4Chat Runtime currently owns Task T's active Harness turn, identified
 *	by the canonical Room sequence of its trigger
 *	  + the Room sends a transient private control naming Task T and that
 *	    exact turnSequence
 *	  = cancel that turn through the existing Adapter.CancelTurn()
 *
 * A Task scope alone is NOT turn identity: the same Task runs many turns, so
 * matching only the scope would let a delayed or stale control kill a later
 * turn. Turn identity is the canonical addressed Room sequence the Runtime
 * already received as `target` at the serialized admission boundary.
 *
 * It is NOT: Task deletion, leaving the Room, killing the Runtime or the
 * Harness process, clearing Task history, cancelling another client's turn,
 * or steering/taking over a native CLI session. The Runtime never trusts the
 * control by itself — authorization comes from the turn it already owns.
 *
 * A control with no matching active turn is a local no-op. It is never
 * retained as a pending intent, because a stale button click must never be
 * able to cancel a future turn that happens to reuse the same Task scope.
 */

// applyResidentTaskControl handles one private resident control frame. It is
// called from the resident event loop and never from the human/Room path.
func (r *ResidentRuntime) applyResidentTaskControl(control *types.ResidentTaskControl) {
	if control == nil || control.Kind != types.ResidentTaskControlInterrupt {
		return
	}
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
