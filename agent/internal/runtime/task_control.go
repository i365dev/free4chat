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
 *	Free4Chat Runtime currently owns Task T's active Harness turn
 *	  + the Room sends a transient private control naming Task T
 *	  = cancel that turn through the existing Adapter.CancelTurn()
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
	if requestedScope == "" {
		return
	}
	if !r.cancelActiveTaskTurn(requestedScope) {
		// Stale, duplicated, wrong-Task, or no active turn at all: report the
		// bounded outcome and change nothing.
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

// cancelActiveTaskTurn is the authority boundary. The Runtime cancels only
// when its own serialized prompt admission currently records exactly this
// scope as the active turn. ACP's adapter-level CancelTurn is then the correct
// seam: once the Runtime has proven the active scope matches, it is cancelling
// its own in-flight prompt (the adapter permits only one at a time) and never
// another client's conversation.
func (r *ResidentRuntime) cancelActiveTaskTurn(scope string) bool {
	r.activityMu.Lock()
	authorized := r.activityTurnActive && r.activityScope == scope
	r.activityMu.Unlock()
	if !authorized {
		return false
	}
	if r.options.Adapter == nil {
		return false
	}
	// The lock is released before the adapter call: a cancellation may cause
	// the Harness to emit a final activity update, which re-enters this
	// Runtime through observeHarnessActivity and must not deadlock here.
	if err := r.options.Adapter.CancelTurn(); err != nil {
		r.log("task_interrupt_cancel_failed", map[string]string{"scopeKind": scopeKindOf(scope)})
		return true
	}
	return true
}
