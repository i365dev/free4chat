package runtime

import (
	"errors"
	"strings"
	"time"

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
	sessionID string
	cwd       string
	// humanParticipantID optionally pins the adoption to one Human's Task. When
	// empty, binding requires exactly one Human in the Room.
	humanParticipantID string
	armedAt            time.Time
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
func (r *ResidentRuntime) ArmSessionAdoption(sessionID, cwd, humanParticipantID string) error {
	if r.isStopped() {
		return errors.New("resident runtime is stopped")
	}
	if _, err := r.handoffAdapter(); err != nil {
		return err
	}
	sessionID = strings.TrimSpace(sessionID)
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
		sessionID:          sessionID,
		cwd:                strings.TrimSpace(cwd),
		humanParticipantID: strings.TrimSpace(humanParticipantID),
		armedAt:            time.Now(),
	}
	return nil
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
// Task turn. The Task must be canonically Human-owned (the trigger carries the
// Human's collaboration request for this Agent), which is the same ownership
// every existing Task control depends on.
func (r *ResidentRuntime) adoptionMayBind(scope string, target int64, adoption *pendingSessionAdoption) bool {
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
// scope. The adoption is consumed exactly once: a load failure leaves the scope
// marked unavailable (never a silent fresh session) and drops the pending
// adoption so a later Task cannot inherit it by accident.
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
	// Consume before the load: the local session identity must not outlive the
	// attempt, and the adapter owns it once loaded.
	r.pendingAdoption = nil
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
	r.mu.Lock()
	r.adoptedScopes[scope] = struct{}{}
	delete(r.adoptedLostScopes, scope)
	r.mu.Unlock()
	r.log("session_adopted", map[string]string{"scopeKind": scopeKindOf(scope)})
	return nil
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
