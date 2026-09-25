package runtime

import (
	"strconv"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Terminal Task scope reclamation (#473).
 *
 * MaxLogicalTaskScopes is a resident-local SAFETY bound, not a Task lifecycle
 * policy. A scope is admitted when a Task-correlated Room event first arrives,
 * and it is retained so a later instruction for the same Task continues the
 * same Harness conversation. Nothing used to give those slots back, so a
 * long-lived resident could turn the bound into "at most eight Tasks per Agent
 * lifetime".
 *
 * This file reclaims exactly one kind of scope: a canonical Task scope whose
 * collaboration lifecycle is TERMINAL and which is completely IDLE. A terminal
 * Task has no work in flight, so giving its slot back can never drop accepted
 * work.
 *
 * What reclamation is NOT:
 *
 *   - it is not eager. A scope is released only when another Task would
 *     otherwise be refused for capacity, so ordinary continuation is untouched
 *     until the bound actually matters;
 *   - it is not idle-time eviction. A Task that is merely quiet — waiting for a
 *     Human, mid-conversation, or parked after a failed turn whose recovery is
 *     still open — is never reclaimed, because "quiet" is not "finished";
 *   - it is not a conversation swap. A conversation the adapter can still
 *     materialize is remembered as THIS Task's exact conversation: the scope
 *     state is removed, but its delivery knowledge and session markers move to
 *     the bounded released-scope ledger below, so a later instruction resumes
 *     that conversation without being told it is new. A conversation the
 *     adapter cannot keep is reported as gone, and the Task's next instruction
 *     is a genuinely new session the Harness is told is new;
 *   - it is not unbounded. Both the ledger (MaxReleasedTaskScopes) and the
 *     adapter's retained identities (MaxRetainedNativeSessions) are bounded,
 *     and the Runtime forgets an identity before the adapter could evict one.
 */

// releasedTaskScope is the bounded Runtime-side memory of ONE Task scope whose
// exact conversation was given back but can still be materialized. It carries
// exactly the facts that would otherwise be lost with the scope state, so a
// resumed conversation is never described as new, never re-bootstrapped, and
// never fed transcript segments it already consumed.
type releasedTaskScope struct {
	deliveredThrough               int64
	roomDeliveryFloor              int64
	observedHarnessGeneration      int64
	bootstrappedHarnessGeneration  int64
	meetingDeliveredThrough        int64
	meetingDeliveryFloor           int64
	liveTranscriptDeliveredThrough int64
	liveTranscriptDeliveryFloor    int64
	sourceCursors                  map[string]int64
	// adopted marks the Pi exact-continuation binding: forgetting this scope's
	// identity must fail the Task closed instead of letting it start fresh.
	adopted bool
}

// hadConversation reports whether this released scope actually reached a
// Harness conversation, so "the retained conversation is gone" is only ever
// published for a Task that had one.
func (s releasedTaskScope) hadConversation() bool {
	return s.observedHarnessGeneration > 0 || s.bootstrappedHarnessGeneration > 0
}

// reclaimCandidate is one terminal Task scope that MIGHT be released.
type reclaimCandidate struct {
	scope string
	// adopted marks a scope permanently bound to a native conversation the
	// Human handed off. Those are given back last: a released adopted binding
	// fails closed on a later instruction rather than silently starting a new
	// conversation, so it is the stronger promise to break.
	adopted bool
}

// reclaimTerminalTaskScope releases at most ONE terminal, idle Task scope so a
// new Task can be admitted. It reports whether a slot was freed.
//
// It is called only from the capacity path of acceptEvent, and only after that
// path has already failed to admit the incoming scope. Adapter calls happen
// outside r.mu, and every state decision is re-verified under r.mu, so a scope
// that became active in the meantime is left completely alone.
//
// A slot is freed only when the adapter actually gave the conversation back.
// Without that confirmation the Runtime keeps its existing fail-closed
// rejection instead of moving the same capacity failure into the adapter.
func (r *ResidentRuntime) reclaimTerminalTaskScope() bool {
	releaser, ok := r.options.Adapter.(types.ScopedHarnessReleaser)
	if !ok {
		return false
	}
	for _, candidate := range r.terminalReclaimCandidates() {
		if r.boundToRunningConversation(candidate.scope) {
			// This scope's conversation is executing a turn for another scope.
			// The adapter must refuse the release anyway; do not even try, so
			// the candidate scan stays one bounded pass.
			continue
		}
		if !r.confirmReclaimableTaskScope(candidate.scope) {
			continue
		}
		retained, err := releaser.ReleaseSessionFor(candidate.scope, true)
		if err != nil {
			r.log("task_scope_release_skipped", map[string]string{"scopeKind": "task"})
			continue
		}
		released, ok := r.releaseTerminalTaskScope(candidate.scope, candidate.adopted)
		if !ok {
			// The scope became active while its conversation was being given
			// back. Its accepted work and its scope are kept; the next turn for
			// it materializes the retained conversation, or a new session the
			// Harness is explicitly told is new.
			r.log("task_scope_release_raced", map[string]string{"scopeKind": "task"})
			return false
		}
		if retained {
			for _, eviction := range r.rememberReleasedConversation(candidate.scope, released) {
				// The released-scope window is full: the oldest remembered
				// conversation is forgotten for good, so its identity is given
				// back too and a later instruction starts a new session instead
				// of pretending to continue a conversation nobody remembers.
				r.forgetReleasedConversation(eviction)
			}
		} else if candidate.adopted {
			r.noteAdoptedConversationGone(candidate.scope)
		} else if released.hadConversation() {
			// The adapter could not keep a conversation this Task actually had.
			// The Human is told it is gone instead of silently receiving replies
			// from a conversation without memory.
			r.publishReleasedTaskAvailability(candidate.scope)
		}
		r.log("task_scope_reclaimed", map[string]string{
			"scopeKind": "task",
			"adopted":   strconv.FormatBool(candidate.adopted),
			"retained":  strconv.FormatBool(retained),
		})
		return true
	}
	return false
}

// confirmReclaimableTaskScope re-proves one candidate's eligibility under r.mu
// immediately before its conversation is given back.
func (r *ResidentRuntime) confirmReclaimableTaskScope(scope string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reclaimableTaskScopeLocked(scope)
}

// terminalReclaimCandidates lists the terminal Task scopes that could be given
// back, in admission order, with adopted scopes last. The list is bounded by
// the resident scope bound, and it is only a candidate list: the authoritative
// eligibility check happens under r.mu at release time.
func (r *ResidentRuntime) terminalReclaimCandidates() []reclaimCandidate {
	r.mu.Lock()
	defer r.mu.Unlock()
	var plain, adopted []reclaimCandidate
	for _, scope := range r.scopeOrder {
		state := r.scopedSessions[scope]
		if state == nil || !state.terminal || !taskExecutionScope(scope) {
			continue
		}
		if r.isAdoptedScopeLocked(scope) {
			adopted = append(adopted, reclaimCandidate{scope: scope, adopted: true})
			continue
		}
		plain = append(plain, reclaimCandidate{scope: scope})
	}
	return append(plain, adopted...)
}

// releaseTerminalTaskScope removes one scope's Runtime state after re-proving,
// under r.mu, that it is still terminal and still completely idle. It returns
// the conversation metadata a retained release must keep. It never touches Room
// state and never acknowledges anything.
func (r *ResidentRuntime) releaseTerminalTaskScope(scope string, adopted bool) (releasedTaskScope, bool) {
	r.mu.Lock()
	if !r.reclaimableTaskScopeLocked(scope) {
		r.mu.Unlock()
		return releasedTaskScope{}, false
	}
	state := r.scopedSessions[scope]
	released := releasedTaskScope{adopted: adopted}
	if state != nil {
		released.deliveredThrough = state.deliveredThrough
		released.roomDeliveryFloor = state.roomDeliveryFloor
		released.observedHarnessGeneration = state.observedHarnessGeneration
		released.bootstrappedHarnessGeneration = state.bootstrappedHarnessGeneration
		released.meetingDeliveredThrough = state.meetingDeliveredThrough
		released.meetingDeliveryFloor = state.meetingDeliveryFloor
		released.liveTranscriptDeliveredThrough = state.liveTranscriptDeliveredThrough
		released.liveTranscriptDeliveryFloor = state.liveTranscriptDeliveryFloor
		if len(state.sourceCursors) > 0 {
			released.sourceCursors = make(map[string]int64, len(state.sourceCursors))
			for source, cursor := range state.sourceCursors {
				released.sourceCursors[source] = cursor
			}
		}
	}
	delete(r.scopedSessions, scope)
	kept := r.scopeOrder[:0]
	for _, ordered := range r.scopeOrder {
		if ordered != scope {
			kept = append(kept, ordered)
		}
	}
	r.scopeOrder = kept
	for key := range r.turnRetries {
		if key.scope == scope {
			delete(r.turnRetries, key)
		}
	}
	for key := range r.closedTurnRecovery {
		if key.scope == scope {
			delete(r.closedTurnRecovery, key)
		}
	}
	delete(r.turnFailedGeneration, scope)
	// The Task's IDENTITY record is deliberately untouched here: the selected
	// project, the Human's native controls, and the adopted-native-conversation
	// binding still describe this Task, and a continued instruction must still
	// honor them. Only the CONVERSATION state — delivery cursors, generations,
	// pending queues, retry bookkeeping, and the materialized binding — moves
	// out of the scope. Identity records are bounded by the Room's retained Task
	// set instead (see task_identity.go).
	r.mu.Unlock()

	// Per-scope transient state lives behind its own locks. Removing it here is
	// what keeps a reclaimed scope from leaving a stale projection, activity,
	// interrupt marker, or recovery entry behind for a later scope of the same
	// id.
	r.activityMu.Lock()
	delete(r.activities, scope)
	delete(r.interrupts, scope)
	r.activityMu.Unlock()
	r.taskExecutionMu.Lock()
	delete(r.taskExecutionFacts, scope)
	r.taskExecutionMu.Unlock()
	// A queued publication for this scope is deliberately left alone: it is the
	// truthful last projection of that Task and the Room already owns it.
	return released, true
}

// releasedConversationEviction is one conversation that left the bounded
// released-scope window. Its adoption fact is captured BEFORE the entry is
// dropped, because forgetting an adopted conversation must still fail that Task
// closed instead of letting it start fresh.
type releasedConversationEviction struct {
	scope   string
	adopted bool
}

// rememberReleasedConversation records one released-but-materializable Task
// conversation. It returns the conversations evicted from the bounded window so
// the caller can forget them (forgetting needs the adapter and therefore runs
// outside every Runtime lock).
func (r *ResidentRuntime) rememberReleasedConversation(scope string, released releasedTaskScope) []releasedConversationEviction {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.releasedTaskScopes == nil {
		r.releasedTaskScopes = make(map[string]releasedTaskScope)
	}
	if _, replacing := r.releasedTaskScopes[scope]; !replacing {
		r.releasedTaskOrder = append(r.releasedTaskOrder, scope)
	}
	r.releasedTaskScopes[scope] = released
	var evicted []releasedConversationEviction
	for len(r.releasedTaskOrder) > types.MaxReleasedTaskScopes {
		oldest := r.releasedTaskOrder[0]
		r.releasedTaskOrder = r.releasedTaskOrder[1:]
		eviction := releasedConversationEviction{scope: oldest, adopted: r.releasedTaskScopes[oldest].adopted}
		delete(r.releasedTaskScopes, oldest)
		evicted = append(evicted, eviction)
	}
	return evicted
}

// forgetReleasedConversation gives back one evicted conversation's exact native
// identity, so the adapter's retained table cannot outgrow the Runtime's own
// window. The ledger entry is already gone: the window evicted it.
func (r *ResidentRuntime) forgetReleasedConversation(eviction releasedConversationEviction) {
	scope := eviction.scope
	if releaser, ok := r.options.Adapter.(types.ScopedHarnessReleaser); ok {
		if _, err := releaser.ReleaseSessionFor(scope, false); err != nil {
			r.log("released_scope_forget_skipped", map[string]string{"scopeKind": "task"})
		}
	}
	if eviction.adopted {
		r.noteAdoptedConversationGone(scope)
		return
	}
	// An ordinary Task loses its remembered conversation here, so its next
	// instruction is a genuinely new session. The truthful availability tells
	// the Human instead of silently replacing the conversation.
	r.publishReleasedTaskAvailability(scope)
	r.log("released_scope_forgotten", map[string]string{"scopeKind": "task"})
}

// adoptReleasedConversationLocked seeds a newly admitted scope from the
// released-scope ledger, so a conversation the Runtime gave back resumes with
// its own delivery knowledge and session markers. Callers must hold r.mu.
func (r *ResidentRuntime) adoptReleasedConversationLocked(scope string, state *logicalSessionState) {
	if r.releasedTaskScopes == nil {
		return
	}
	released, ok := r.releasedTaskScopes[scope]
	if !ok {
		return
	}
	delete(r.releasedTaskScopes, scope)
	kept := r.releasedTaskOrder[:0]
	for _, ordered := range r.releasedTaskOrder {
		if ordered != scope {
			kept = append(kept, ordered)
		}
	}
	r.releasedTaskOrder = kept

	state.deliveredThrough = released.deliveredThrough
	state.roomDeliveryFloor = released.roomDeliveryFloor
	state.observedHarnessGeneration = released.observedHarnessGeneration
	state.bootstrappedHarnessGeneration = released.bootstrappedHarnessGeneration
	state.meetingDeliveredThrough = released.meetingDeliveredThrough
	state.meetingDeliveryFloor = released.meetingDeliveryFloor
	state.liveTranscriptDeliveredThrough = released.liveTranscriptDeliveredThrough
	state.liveTranscriptDeliveryFloor = released.liveTranscriptDeliveryFloor
	if len(released.sourceCursors) > 0 {
		state.sourceCursors = make(map[string]int64, len(released.sourceCursors))
		for source, cursor := range released.sourceCursors {
			state.sourceCursors[source] = cursor
		}
	}
	state.rematerializing = true
}

// clearReleasedConversationsLocked drops the whole released-scope ledger. It is
// used by the lifecycle reset, where a brand-new resident starts from scratch.
// Callers must hold r.mu.
func (r *ResidentRuntime) clearReleasedConversationsLocked() {
	r.releasedTaskScopes = nil
	r.releasedTaskOrder = nil
}

// reclaimableTaskScopeLocked is the authoritative eligibility predicate for
// releasing one scope. Callers must hold r.mu.
func (r *ResidentRuntime) reclaimableTaskScopeLocked(scope string) bool {
	if !taskExecutionScope(scope) {
		return false
	}
	state := r.scopedSessions[scope]
	if state == nil || !state.terminal {
		return false
	}
	// Running work, accepted work, and any unacknowledged turn bookkeeping all
	// mean the Task is not finished, whatever its last published lifecycle
	// said. A pending Room permission needs no separate check: it is answered
	// inside the very turn that is holding this scope's lane, so the
	// active-turn fence below already covers it.
	if _, running := r.activeTurns[scope]; running {
		return false
	}
	if len(state.pendingAddressed) > 0 || len(state.pendingContexts) > 0 {
		return false
	}
	for key := range r.turnRetries {
		if key.scope == scope {
			return false
		}
	}
	for key := range r.closedTurnRecovery {
		if key.scope == scope {
			return false
		}
	}
	return true
}

// terminalLifecycleKind reports whether one collaboration envelope kind is a
// terminal Task lifecycle state. The set mirrors the Room's own Task
// projection: completed and failed are terminal, and a decline is projected as
// Failed.
func terminalLifecycleKind(kind types.CollabKind) bool {
	switch kind {
	case types.CollabDeclined, types.CollabComplete, types.CollabFailed:
		return true
	default:
		return false
	}
}

// noteTaskScopeTerminal records the canonical terminal lifecycle state of one
// Task by request id. It never creates scope state: a result for a Task this
// Runtime refused (capacity, shutdown) marks nothing at all.
func (r *ResidentRuntime) noteTaskScopeTerminal(taskRequestID string) {
	scope := taskScopeForRequestID(strings.TrimSpace(taskRequestID))
	if scope == "" {
		return
	}
	r.mu.Lock()
	if state := r.scopedSessions[scope]; state != nil {
		state.terminal = true
	}
	r.mu.Unlock()
}

// observeTaskScopeTerminalLocked records a terminal lifecycle envelope the
// Room delivered for one already-routed scope. Callers must hold r.mu.
func (r *ResidentRuntime) observeTaskScopeTerminalLocked(scope string, event types.RoomEvent) {
	if event.Collab == nil || !terminalLifecycleKind(event.Collab.Kind) {
		return
	}
	// The lifecycle identity must be THIS scope's own Task: a terminal
	// envelope for another Task can never make this one eligible for
	// reclamation, and an envelope with no usable correlation id proves
	// nothing at all.
	if taskScopeForRequestID(strings.TrimSpace(event.Collab.RequestID)) != scope {
		return
	}
	if state := r.scopedSessions[scope]; state != nil {
		state.terminal = true
	}
}

// noteAdoptedConversationGone records that an adopted Task's native
// conversation no longer exists. This is the same factual state as a failed
// native load: the Task fails closed from here on, and a later instruction is
// never answered by a substitute conversation.
func (r *ResidentRuntime) noteAdoptedConversationGone(scope string) {
	r.mu.Lock()
	identity := r.recordTaskIdentityLocked(scope)
	identity.adopted = true
	identity.adoptedLost = true
	r.mu.Unlock()
	r.publishReleasedTaskAvailability(scope)
	r.log("adopted_session_released", map[string]string{"scopeKind": "task"})
}

// publishReleasedTaskAvailability publishes the truthful "the retained
// conversation for this Task is gone" availability for a scope the Runtime no
// longer owns. The transient local fact is dropped immediately after the
// publication is queued: the Room owns that projection from then on, and a Task
// the Runtime has forgotten must not leave local state behind.
func (r *ResidentRuntime) publishReleasedTaskAvailability(scope string) {
	r.markTaskSessionLost(scope)
	r.taskExecutionMu.Lock()
	delete(r.taskExecutionFacts, scope)
	r.taskExecutionMu.Unlock()
}
