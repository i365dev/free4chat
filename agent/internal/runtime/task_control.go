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
// ACP's adapter-level CancelTurn is the correct seam here: once the Runtime has
// proven which turn it owns, the adapter's single in-flight prompt is that
// turn, so this never cancels another client's conversation. No CancelTurnFor
// and no HarnessAdapter change is introduced.
func (r *ResidentRuntime) cancelActiveTaskTurn(scope string, turnSequence int64) bool {
	if r.options.Adapter == nil {
		return false
	}
	r.turnControlMu.Lock()
	defer r.turnControlMu.Unlock()

	r.activityMu.Lock()
	authorized := r.activityTurnActive &&
		r.activityScope == scope &&
		r.activityTurnSequence == turnSequence
	// activityMu is released before the adapter call: a cancellation may cause
	// the Harness to emit a final activity update, which re-enters this Runtime
	// through observeHarnessActivity and must not deadlock here. turnControlMu
	// stays held, which is what makes the check-and-dispatch atomic.
	r.activityMu.Unlock()
	if !authorized {
		return false
	}
	if err := r.options.Adapter.CancelTurn(); err != nil {
		r.log("task_interrupt_cancel_failed", map[string]string{"scopeKind": scopeKindOf(scope)})
		return true
	}
	return true
}
