package runtime

import (
	"errors"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/harness"
	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Pi existing-session handoff (#409, V1).
 *
 * This is the smallest verified cold-resume slice: a locally armed adoption
 * binds an EXISTING native Pi session to the next eligible canonical Human Task
 * scope, so the first Free4Chat Task turn continues the native conversation
 * instead of starting a fresh one.
 *
 *	handoff --list            -> bounded local discovery through the adapter
 *	handoff --adopt <id>      -> ONE pending local adoption (runtime memory)
 *	Human creates the Task    -> canonical task:<requestId> exists
 *	first Task turn admission -> LoadSession(task:<requestId>, <id>)
 *	                          -> session/load, never session/new, for that scope
 *
 * It is NOT hot takeover, cross-client cancel, or steering: the native Pi turn
 * must already be idle before the Human hands the session off. Free4Chat never
 * claims it can cancel work still owned by the original native CLI process.
 *
 * Privacy: the ACP session id lives only in the CLI argument, the daemon IPC
 * message, and this pending runtime state. It is never written to Room state,
 * Room messages, prompts, status, workspace files, analytics, or logs, and it
 * is DROPPED from runtime state as soon as the adapter has loaded it — after
 * that the adapter owns the identity and the runtime keeps only the fact that
 * this scope is adopted.
 */

var (
	// errSessionAdoptionUnsupported means this resident is not a V1-eligible
	// (Pi) Harness, or its adapter cannot list/load sessions at all.
	errSessionAdoptionUnsupported = errors.New("session handoff is supported for the Pi Harness only")
	// errSessionAdoptionArmed means one adoption is already pending. V1 keeps at
	// most one; it is consumed by a Task or explicitly cleared.
	errSessionAdoptionArmed = errors.New("a session adoption is already armed")
	// errSessionAdoptionNotArmed means nothing was pending to clear.
	errSessionAdoptionNotArmed = errors.New("no session adoption is armed")
	// errAdoptedSessionUnavailable means this Task adopted a native session and
	// that conversation is no longer available. The Task must not silently
	// continue on a fresh one.
	errAdoptedSessionUnavailable = errors.New("the adopted session for this Task is no longer available")
)

// v1HandoffHarnessID is the only Harness admitted for V1 handoff. Admission is
// deliberately a named-product decision, not a capability check: the spike
// proved that advertised sessionCapabilities.list/loadSession is NOT evidence
// that a native session can actually be continued (OpenCode and Hermes both
// advertise and still fail).
const v1HandoffHarnessID = "pi"

// maxAdoptedSessionIDRunes matches the adapter's own bound on an opaque ACP
// session identity; the runtime only rejects obviously unusable input and lets
// the adapter own the real validation.
const maxAdoptedSessionIDRunes = 256

// pendingSessionAdoption is ONE locally armed adoption. It carries the minimum
// needed to load the session once a canonical Task scope exists.
type pendingSessionAdoption struct {
	// sessionID and cwd are opaque identity-bearing inputs: they are accepted
	// unchanged or rejected, never trimmed or repaired (#412).
	sessionID string
	cwd       string
	// humanParticipantID optionally pins the adoption to one Human's Task. When
	// empty, binding requires exactly one Human in the Room.
	humanParticipantID string
	// armedAfterSequence is the canonical Room sequence fence captured at arm
	// time: only a Task whose trigger sequence is strictly greater may consume
	// this adoption. A Task that was already received or admitted before the
	// operator armed the handoff must follow its normal fresh-session path and
	// leave the adoption armed, no matter how long it waits in the queue.
	armedAfterSequence int64
}

// sessionHandoffAdapter is the narrow local seam this slice needs: the concrete
// ACP adapter already implements it (#412). It is declared here instead of in
// types.HarnessAdapter so no unrelated adapter or fake is forced to grow
// session methods.
type sessionHandoffAdapter interface {
	ListSessions(cwd string, cursor string) (harness.ACPSessionPage, error)
	LoadSession(scope string, sessionID string, cwd string) error
}

// handoffAdapter returns this resident's adapter when it is the V1-eligible Pi
// Harness and implements the session primitives.
func (r *ResidentRuntime) handoffAdapter() (sessionHandoffAdapter, error) {
	if r.options.Adapter == nil ||
		!strings.EqualFold(strings.TrimSpace(r.options.Adapter.Name()), v1HandoffHarnessID) {
		return nil, errSessionAdoptionUnsupported
	}
	adapter, ok := r.options.Adapter.(sessionHandoffAdapter)
	if !ok {
		return nil, errSessionAdoptionUnsupported
	}
	return adapter, nil
}

// ListHarnessSessions returns the bounded native session descriptors the
// resident Pi Harness can discover. It is local CLI output only: nothing here
// is persisted, projected into the Room, or written to logs.
func (r *ResidentRuntime) ListHarnessSessions(cwd string, cursor string) (harness.ACPSessionPage, error) {
	if r.isStopped() {
		return harness.ACPSessionPage{}, errors.New("resident runtime is stopped")
	}
	adapter, err := r.handoffAdapter()
	if err != nil {
		return harness.ACPSessionPage{}, err
	}
	return adapter.ListSessions(cwd, cursor)
}

// ArmSessionAdoption arms the ONE pending adoption. It never touches Room state
// and never loads anything: the canonical Task scope does not exist until a
// Human creates the Task.
//
// The session id and cwd are identity-bearing: they are accepted exactly as
// given or rejected outright, never trimmed or otherwise repaired, so the value
// that reaches the adapter's session/load is byte-for-byte what the operator
// selected. Final session-identity validation stays with the #412 adapter.
func (r *ResidentRuntime) ArmSessionAdoption(sessionID, cwd, humanParticipantID string) error {
	if r.isStopped() {
		return errors.New("resident runtime is stopped")
	}
	if _, err := r.handoffAdapter(); err != nil {
		return err
	}
	if sessionID == "" {
		return errors.New("session id is required")
	}
	if len([]rune(sessionID)) > maxAdoptedSessionIDRunes {
		return errors.New("session id is invalid")
	}
	for _, r := range sessionID {
		if r <= ' ' || r == 0x7f {
			return errors.New("session id is invalid")
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return errors.New("resident runtime is stopped")
	}
	if r.pendingAdoption != nil {
		return errSessionAdoptionArmed
	}
	r.pendingAdoption = &pendingSessionAdoption{
		sessionID: sessionID,
		cwd:       cwd,
		// A Room participant id is not an ACP identity, and the operator may
		// paste it with surrounding whitespace.
		humanParticipantID: strings.TrimSpace(humanParticipantID),
		// The fence is this Runtime's canonical receipt/admission boundary at
		// the moment the adoption is armed. It is captured under r.mu together
		// with the pending adoption, so a Task admitted concurrently is either
		// fully before the fence or fully after it — never half of each.
		armedAfterSequence: r.admissionBoundaryLocked(),
	}
	return nil
}

// admissionBoundaryLocked reports the highest canonical Room sequence this
// Runtime has received or admitted. It is the ordering authority for the
// handoff fence: wall-clock time is not causally meaningful here because a Task
// can be received long before the serial drain reaches it.
//
// It deliberately combines the monotonic Room receipt cursor (the transport
// boundary, which also covers filtered and self-originated events), the bounded
// event buffer (an envelope may be mid-ingestion, before the cursor advances),
// and every already-admitted canonical sequence per logical scope. A value
// greater than this boundary can only come from an event the Runtime had not
// received when the caller read it. Callers must hold r.mu.
func (r *ResidentRuntime) admissionBoundaryLocked() int64 {
	boundary := r.cursor
	if latest := r.eventBuffer.LatestSequence(); latest > boundary {
		boundary = latest
	}
	consider := func(ref *logicalSessionRef) {
		if ref == nil {
			return
		}
		if ref.deliveredThrough != nil && *ref.deliveredThrough > boundary {
			boundary = *ref.deliveredThrough
		}
		if ref.roomDeliveryFloor != nil && *ref.roomDeliveryFloor > boundary {
			boundary = *ref.roomDeliveryFloor
		}
		if ref.pendingAddressed != nil {
			for _, target := range *ref.pendingAddressed {
				if target > boundary {
					boundary = target
				}
			}
		}
	}
	consider(r.sessionRefLocked(roomScope))
	for _, scope := range r.scopeOrder {
		consider(r.sessionRefLocked(scope))
	}
	return boundary
}

// ClearSessionAdoption drops an armed adoption. It is the operator's recovery
// path from a mistaken --adopt; it never touches an already adopted Task.
func (r *ResidentRuntime) ClearSessionAdoption() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingAdoption == nil {
		return errSessionAdoptionNotArmed
	}
	r.pendingAdoption = nil
	return nil
}

// SessionAdoptionState reports the bounded local adoption state for the CLI.
// It deliberately does NOT return the session id.
func (r *ResidentRuntime) SessionAdoptionState() (armed bool, humanParticipantID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingAdoption == nil {
		return false, ""
	}
	return true, r.pendingAdoption.humanParticipantID
}

// admitHarnessSession is the serialized Task-scope admission boundary. It is
// the ONLY place a scope gets its Harness session, and it is what makes the
// handoff ordering safe:
//
//   - an armed adoption that may bind THIS canonical Human-owned Task loads the
//     selected native session into exactly this scope, so session/new is never
//     issued for an adopted Task — not before the load and not after it;
//   - a Task that already adopted a native session never creates a fresh one,
//     even after that session is lost: it fails closed instead;
//   - every other Task keeps the existing fresh-scope behavior unchanged.
func (r *ResidentRuntime) admitHarnessSession(scope string, target int64) error {
	if scope == roomScope {
		return r.ensureHarnessSession(scope)
	}
	r.mu.Lock()
	_, adopted := r.adoptedScopes[scope]
	_, lost := r.adoptedLostScopes[scope]
	adoption := r.pendingAdoption
	r.mu.Unlock()

	if adopted {
		if lost {
			return errAdoptedSessionUnavailable
		}
		// The adapter already retains the loaded session for this scope; this
		// never creates a second conversation.
		return r.ensureHarnessSession(scope)
	}
	if adoption != nil && r.adoptionMayBind(scope, target, adoption) {
		return r.bindSessionAdoption(scope, adoption)
	}
	return r.ensureHarnessSession(scope)
}

// adoptionMayBind decides whether one armed adoption may be consumed by THIS
// Task turn. Three independent facts must all hold: the Task must be
// canonically Human-owned (the trigger carries the Human's collaboration
// request for this Agent, the same ownership every existing Task control
// depends on), it must be pinned to the armed Human (or the Room must have
// exactly one Human, who owns the Task), and its canonical trigger sequence
// must be AFTER the fence captured when the adoption was armed.
//
// The sequence fence is what keeps the handoff causal: a Task that already
// existed in the Runtime when the operator armed the adoption must never
// consume it, even if the serial drain only reaches that Task much later.
func (r *ResidentRuntime) adoptionMayBind(scope string, target int64, adoption *pendingSessionAdoption) bool {
	if target <= adoption.armedAfterSequence {
		return false
	}
	events, err := r.pendingContextFor(scope, target)
	if err != nil {
		return false
	}
	request := humanTaskRequestFor(events, r.currentParticipantID())
	if request == nil || request.FromParticipantID == "" {
		return false
	}
	if adoption.humanParticipantID != "" {
		return request.FromParticipantID == adoption.humanParticipantID
	}
	// Ambiguity rule: without an explicit --human the adoption binds only when
	// the Room has exactly one Human, and that Human owns the Task.
	return r.singleHumanParticipantID() == request.FromParticipantID
}

// isAdoptedScope reports whether this canonical Task scope is permanently bound
// to a native conversation the Human handed off. It stays true after that
// conversation is lost: an adopted Task never falls back to a fresh one.
func (r *ResidentRuntime) isAdoptedScope(scope string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, adopted := r.adoptedScopes[scope]
	return adopted
}

// singleHumanParticipantID returns the one Human in the current roster, or ""
// when the Room has none or more than one.
func (r *ResidentRuntime) singleHumanParticipantID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	found := ""
	for _, participant := range r.roster {
		if participant.Kind != types.KindHuman {
			continue
		}
		if found != "" {
			return ""
		}
		found = participant.ID
	}
	return found
}

// bindSessionAdoption loads the selected native session into exactly this Task
// scope, and the ownership transition is committed BEFORE the external
// session/load is attempted.
//
// That ordering is the whole point: once this canonical Task has been matched
// with the selected native conversation, it must never again be eligible for
// fresh-session fallback — not while the load is in flight, not after a load
// failure, and not after the Harness dies. If the ACP child dies during the
// load, the unexpected-failure boundary already sees the scope as adopted and
// records it as lost; the success path below refuses to clear that loss, so the
// first Task turn never starts on a conversation that is already gone.
func (r *ResidentRuntime) bindSessionAdoption(scope string, adoption *pendingSessionAdoption) error {
	adapter, err := r.handoffAdapter()
	if err != nil {
		return err
	}
	r.mu.Lock()
	if r.pendingAdoption != adoption {
		// Another serialized turn consumed it first; fall back to the normal
		// path for this scope rather than loading twice.
		r.mu.Unlock()
		return r.ensureHarnessSession(scope)
	}
	sessionID, cwd := adoption.sessionID, adoption.cwd
	// Consume the pending identity before the load: the Runtime must not retain
	// the ACP session id once the adapter owns it. Commit the adopted ownership
	// in the SAME critical section, so "this Task is adopted" is never
	// observable as a half state. The lost bit is cleared because a scope can
	// only reach this point while it is not adopted, so a lost fact here would
	// describe a binding that no longer exists.
	r.pendingAdoption = nil
	r.adoptedScopes[scope] = struct{}{}
	delete(r.adoptedLostScopes, scope)
	r.mu.Unlock()

	if err := adapter.LoadSession(scope, sessionID, cwd); err != nil {
		// A load failure is terminal for this adoption: no retry can change
		// the fact that this scope now keeps the conversation it could not
		// adopt. The adapter's own error may quote local ACP identity, so
		// only its bounded failure class is logged, and the turn fails with
		// the one fixed, secret-free adopted-session error.
		r.markAdoptedScopeUnavailable(scope)
		r.log("session_adoption_failed", map[string]string{
			"scopeKind":    scopeKindOf(scope),
			"failureClass": turnFailureClassOf(err),
		})
		return errAdoptedSessionUnavailable
	}
	// The load reported success, but the Harness may have died while it was in
	// flight — that loss was recorded by the failure boundary WHILE this scope
	// was already adopted. It is authoritative and must never be erased by a
	// late success, so the first Task turn does not start.
	if r.adoptedScopeLost(scope) {
		r.log("session_adoption_lost_during_load", map[string]string{"scopeKind": scopeKindOf(scope)})
		return errAdoptedSessionUnavailable
	}
	r.log("session_adopted", map[string]string{"scopeKind": scopeKindOf(scope)})
	return nil
}

// adoptedScopeLost reports whether the failure boundary recorded this adopted
// scope's conversation as gone.
func (r *ResidentRuntime) adoptedScopeLost(scope string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, lost := r.adoptedLostScopes[scope]
	return lost
}

// noteAdoptedScopeLoss marks every adopted Task scope as unavailable after an
// unexpected Harness death. Their execution projection already fails closed
// through the existing session-lost boundary; this is the additional fact that
// stops the NEXT instruction from silently starting a fresh conversation.
func (r *ResidentRuntime) noteAdoptedScopeLoss() {
	r.mu.Lock()
	scopes := make([]string, 0, len(r.adoptedScopes))
	for scope := range r.adoptedScopes {
		scopes = append(scopes, scope)
		r.adoptedLostScopes[scope] = struct{}{}
	}
	r.mu.Unlock()
	for _, scope := range scopes {
		r.log("adopted_session_lost", map[string]string{"scopeKind": scopeKindOf(scope)})
	}
}

// markAdoptedScopeUnavailable records that a Task's adopted conversation is
// gone (the load failed, or the Harness died later). Such a Task stays failed
// until the Human starts a new Task; Free4Chat never substitutes a fresh
// conversation. The truthful availability is published through the existing
// session-lost projection, so the Human sees the same actionable state in both
// cases instead of a Task that silently stopped.
func (r *ResidentRuntime) markAdoptedScopeUnavailable(scope string) {
	r.mu.Lock()
	r.adoptedScopes[scope] = struct{}{}
	r.adoptedLostScopes[scope] = struct{}{}
	r.mu.Unlock()
	r.markTaskSessionLost(scope)
}

// adoptedScopesSnapshot reports the adopted Task scopes (bounded by the logical
// scope bound). Test/diagnostic helper only: no session identity is retained.
func (r *ResidentRuntime) adoptedScopesSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.adoptedScopes))
	for scope := range r.adoptedScopes {
		out = append(out, scope)
	}
	return out
}
