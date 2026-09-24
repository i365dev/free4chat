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
	// errSessionAdoptionUnsupported means this resident's launcher does not
	// enable Task Session Continuation, or its adapter cannot list/load
	// sessions at all.
	errSessionAdoptionUnsupported = errors.New("session continuation is not supported for this Harness")
	// errSessionAdoptionArmed means one adoption is already pending. V1 keeps at
	// most one; it is consumed by a Task or explicitly cleared.
	errSessionAdoptionArmed = errors.New("a session adoption is already armed")
	// errSessionAdoptionNotArmed means nothing was pending to clear.
	errSessionAdoptionNotArmed = errors.New("no session adoption is armed")
	// errAdoptedSessionUnavailable means this Task adopted a native session and
	// that conversation is no longer available. The Task must not silently
	// continue on a fresh one.
	errAdoptedSessionUnavailable     = errors.New("the adopted session for this Task is no longer available")
	errTaskHarnessControlUnavailable = errors.New("the selected Harness-native Task control is no longer available")
)

// maxAdoptedSessionIDRunes matches the adapter's own bound on an opaque ACP
// session identity; the runtime only rejects obviously unusable input and lets
// the adapter own the real validation.
const maxAdoptedSessionIDRunes = 256

// preparedAdoptionTTL bounds an EXACT prepared adoption. The Room never waits
// anywhere near this long (PREPARE -> PREPARED -> canonical Task append ->
// resident push is one round trip), so the TTL only exists to guarantee that a
// preparation whose Task was never created can never linger and can never be
// mistaken for a live binding.
const preparedAdoptionTTL = 2 * time.Minute

// maxDeclinedPreparedAdoptions bounds the local record of EXACT prepared
// request ids that expired before their Task arrived. It is tiny on purpose:
// the entry exists only so a late canonical Task fails closed instead of
// silently starting a fresh conversation the Human did not ask for.
const maxDeclinedPreparedAdoptions = 16

// declinedPreparedAdoptionTTL bounds how long that fail-closed record lives.
const declinedPreparedAdoptionTTL = 15 * time.Minute

// pendingSessionAdoption is ONE locally armed adoption. It carries the minimum
// needed to load the session once a canonical Task scope exists.
type pendingSessionAdoption struct {
	// sessionID and cwd are opaque identity-bearing inputs: they are accepted
	// unchanged or rejected, never trimmed or repaired (#412).
	sessionID string
	cwd       string
	// newSession marks a project-only Task preparation. No native session id
	// exists yet; the exact cwd is bound to the Task before scoped session/new.
	newSession    bool
	modeID        string
	configOptions map[string]string
	// humanParticipantID optionally pins the adoption to one Human's Task. When
	// empty, binding requires exactly one Human in the Room.
	humanParticipantID string
	// armedAfterSequence is the canonical Room sequence fence captured at arm
	// time: only a Task whose trigger sequence is strictly greater may consume
	// this adoption. A Task that was already received or admitted before the
	// operator armed the handoff must follow its normal fresh-session path and
	// leave the adoption armed, no matter how long it waits in the queue.
	armedAfterSequence int64
	// taskRequestID, when non-empty, makes this an EXACT prepared adoption: it
	// may bind to `task:<taskRequestID>` and to nothing else. This is the
	// browser product path, where the Room already generated the canonical
	// requestId before it asked for the preparation. The CLI handoff leaves it
	// empty and keeps its sequence-fenced "next eligible Task" behavior.
	taskRequestID string
	// expiresAt bounds an ORPHAN exact prepared adoption: one whose canonical
	// Task has not been accepted yet. Zero means "no expiry" for the CLI path,
	// which is cleared by a Task or by hand.
	//
	// Once claimed is set this bound no longer applies — see claimed.
	expiresAt int64
	// claimed means the EXACT canonical Human-owned Task this preparation was
	// pinned to has been ACCEPTED into the Runtime's bounded pending queue.
	//
	// It is a distinct fact from "expiresAt == 0": the CLI path is unbounded by
	// design while waiting for "the next eligible Task", whereas a claimed
	// preparation has already found its one Task and is only waiting for that
	// Task to reach the serialized admission boundary. Conflating the two would
	// make the CLI fence and the browser lifecycle indistinguishable in tests
	// and in the logs.
	//
	// A claimed preparation never expires on the orphan TTL: the serialized
	// drain may legitimately sit behind a long-running predecessor, and the
	// whole point of the preparation is that ITS Task still loads the selected
	// conversation when the drain finally reaches it.
	claimed bool
}

// ArmPreparedProjectTask pins a new Task to one already-validated local
// project. The opaque project token is resolved by the discovery layer; only
// its exact Runtime-private cwd reaches this method.
func (r *ResidentRuntime) ArmPreparedProjectTask(cwd, humanParticipantID, taskRequestID string) error {
	return r.ArmPreparedProjectTaskWithControls(cwd, humanParticipantID, taskRequestID, "", nil)
}

func (r *ResidentRuntime) ArmPreparedProjectTaskWithControls(cwd, humanParticipantID, taskRequestID, modeID string, configOptions map[string]string) error {
	if r.isStopped() {
		return errors.New("resident runtime is stopped")
	}
	if _, err := r.handoffAdapter(); err != nil {
		return err
	}
	if cwd == "" || !taskSessionCwdAvailable(cwd) {
		return errors.New("Task project directory is unavailable")
	}
	human := strings.TrimSpace(humanParticipantID)
	if human == "" {
		return errors.New("human participant id is required")
	}
	if taskScopeForRequestID(taskRequestID) == "" {
		return errors.New("task request id is invalid")
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
		cwd:                cwd,
		newSession:         true,
		modeID:             modeID,
		configOptions:      cloneNativeControlSelections(configOptions),
		humanParticipantID: human,
		armedAfterSequence: r.admissionBoundaryLocked(),
		taskRequestID:      taskRequestID,
		expiresAt:          time.Now().Add(preparedAdoptionTTL).UnixMilli(),
	}
	return nil
}

// declinedPreparedAdoption is the local fail-closed record of one exact
// prepared requestId whose adoption expired before its Task arrived. The Task
// must never silently start a fresh conversation, so it is refused exactly
// like a lost adopted session.
type declinedPreparedAdoption struct {
	taskRequestID string
	expiresAt     int64
}

// sessionHandoffAdapter is the narrow local seam this slice needs: the concrete
// ACP adapter already implements it (#412). It is declared here instead of in
// types.HarnessAdapter so no unrelated adapter or fake is forced to grow
// session methods.
type sessionHandoffAdapter interface {
	ListSessions(options harness.ACPSessionListOptions) (harness.ACPSessionPage, error)
	LoadSession(scope string, sessionID string, cwd string) error
}

// handoffAdapter returns this resident's adapter when its LAUNCHER PRODUCT
// POLICY enables Task Session Continuation and the adapter implements the
// session primitives.
//
// Admission is deliberately NOT a Harness-name check and NOT a capability
// check. The name check is gone because the centralized launcher registry
// (`types.AgentLauncher.TaskSessionContinuation`) is now the single place that
// decides which Harness is enabled; the capability check is absent because the
// #409 spike proved `sessionCapabilities.list`/`loadSession` is NOT evidence
// that a native session can actually be continued (OpenCode and Hermes both
// advertise and still fail). Enabling another Harness is therefore a one-flag
// change in that registry plus its own provider-specific regression probe.
func (r *ResidentRuntime) handoffAdapter() (sessionHandoffAdapter, error) {
	if r.options.Adapter == nil || !r.options.TaskSessionContinuation {
		return nil, errSessionAdoptionUnsupported
	}
	adapter, ok := r.options.Adapter.(sessionHandoffAdapter)
	if !ok {
		return nil, errSessionAdoptionUnsupported
	}
	return adapter, nil
}

// ListHarnessSessions returns the bounded native session descriptors the
// resident Harness can discover for the given options. It is used by the local
// CLI diagnostic path only: the product path goes through the tokenized
// session-discovery cache, which never exposes a session id. Nothing here is
// persisted, projected into the Room, or written to logs.
func (r *ResidentRuntime) ListHarnessSessions(options harness.ACPSessionListOptions) (harness.ACPSessionPage, error) {
	if r.isStopped() {
		return harness.ACPSessionPage{}, errors.New("resident runtime is stopped")
	}
	adapter, err := r.handoffAdapter()
	if err != nil {
		return harness.ACPSessionPage{}, err
	}
	return adapter.ListSessions(options)
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

// ArmPreparedSessionAdoption arms ONE exact adoption for the browser product
// path. Unlike the CLI handoff it does not use "next eligible Task" semantics:
// the Room already generated the canonical Task requestId it is about to
// create, so the adoption is PINNED to exactly that requestId.
//
// It is still expiry-bounded, and it still refuses to coexist with another
// pending adoption, so an incompatible pending preparation fails the prepare
// instead of silently replacing it.
func (r *ResidentRuntime) ArmPreparedSessionAdoption(sessionID, cwd, humanParticipantID, taskRequestID string) error {
	return r.ArmPreparedSessionAdoptionWithControls(sessionID, cwd, humanParticipantID, taskRequestID, "", nil)
}

func (r *ResidentRuntime) ArmPreparedSessionAdoptionWithControls(sessionID, cwd, humanParticipantID, taskRequestID, modeID string, configOptions map[string]string) error {
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
	human := strings.TrimSpace(humanParticipantID)
	if human == "" {
		return errors.New("human participant id is required")
	}
	// The canonical Task id is identity: it is accepted exactly as given or
	// rejected. It is never trimmed or repaired into a different Task.
	if taskScopeForRequestID(taskRequestID) == "" {
		return errors.New("task request id is invalid")
	}
	now := time.Now().UnixMilli()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return errors.New("resident runtime is stopped")
	}
	if r.pendingAdoption != nil {
		return errSessionAdoptionArmed
	}
	r.pruneDeclinedPreparedLocked(now)
	r.pendingAdoption = &pendingSessionAdoption{
		sessionID:          sessionID,
		cwd:                cwd,
		modeID:             modeID,
		configOptions:      cloneNativeControlSelections(configOptions),
		humanParticipantID: human,
		armedAfterSequence: r.admissionBoundaryLocked(),
		taskRequestID:      taskRequestID,
		expiresAt:          now + preparedAdoptionTTL.Milliseconds(),
	}
	return nil
}

func cloneNativeControlSelections(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	clone := make(map[string]string, len(source))
	for id, value := range source {
		clone[id] = value
	}
	return clone
}

// pendingAdoptionSnapshot reports the current armed adoption WITHOUT its
// session identity. Only the exact Task binding is exposed, which is what the
// best-effort cancel path needs to match.
func (r *ResidentRuntime) pendingAdoptionSnapshot() *pendingSessionAdoption {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingAdoption == nil {
		return nil
	}
	snapshot := *r.pendingAdoption
	snapshot.sessionID = ""
	snapshot.cwd = ""
	return &snapshot
}

// claimPreparedAdoptionLocked promotes an ORPHAN exact preparation into a
// CLAIMED one, and is called ONLY from the point where the exact canonical
// Human-owned Task trigger has just been accepted into this scope's bounded
// pending queue.
//
// Claiming here — rather than at the serialized Harness admission boundary — is
// what makes the browser path survivable behind a long-running predecessor:
//
//	Task A: 10-minute Harness turn
//	Human:  Continue session -> PREPARE B -> PREPARED -> canonical Task B
//	reader: Task B accepted into pendingAddressed   <-- CLAIM happens here
//	...     Task A still running, well past B's orphan TTL
//	drain:  Task B -> bindSessionAdoption -> session/load -> RunTurn
//
// It deliberately does NOT load anything: the Harness may be executing another
// Task's turn right now, and #412 load semantics must stay serialized behind
// the same single drain that every other scoped transition uses.
//
// Claiming requires proof, from the accepted event itself, that this IS the
// exact Task the preparation was pinned to:
//
//   - the scope's canonical Task id equals the pinned taskRequestID;
//   - the trigger is a Human-originated collaboration REQUEST addressed to
//     THIS Agent participant (the same ownership every Task control uses);
//   - it comes from the Human the preparation was armed for;
//   - its canonical sequence is strictly after the fence captured at arm time.
//
// A Task trigger the bounded queue REFUSES is never claimed: capacity failure
// must not make a preparation immortal. Callers must hold r.mu.
func (r *ResidentRuntime) claimPreparedAdoptionLocked(scope string, event types.RoomEvent) bool {
	adoption := r.pendingAdoption
	if adoption == nil || adoption.taskRequestID == "" || adoption.claimed {
		return false
	}
	if taskRequestIDForScope(scope) != adoption.taskRequestID {
		return false
	}
	if event.Sequence <= adoption.armedAfterSequence {
		return false
	}
	if !event.Addressed || event.Collab == nil || event.Collab.Kind != types.CollabRequest {
		return false
	}
	if event.Participant.Kind != types.KindHuman {
		return false
	}
	// r.participantID is read directly: the caller holds r.mu.
	if event.Collab.TargetParticipantID != r.participantID {
		return false
	}
	if adoption.humanParticipantID == "" ||
		event.Collab.FromParticipantID != adoption.humanParticipantID {
		return false
	}
	adoption.claimed = true
	return true
}

// expirePreparedAdoptionLocked drops an ORPHAN exact prepared adoption whose
// TTL has passed and records its requestId as declined, so the Task it was
// prepared for can never fall back to a fresh conversation. It reports the
// adoption that is still armed (nil when it just expired or none was armed).
//
// A CLAIMED preparation is never expired here: its exact canonical Task has
// already been accepted and is simply waiting its turn in the serialized
// drain. Callers must hold r.mu.
func (r *ResidentRuntime) expirePreparedAdoptionLocked(now int64) *pendingSessionAdoption {
	adoption := r.pendingAdoption
	if adoption == nil || adoption.claimed || adoption.expiresAt == 0 || adoption.expiresAt > now {
		return adoption
	}
	r.pendingAdoption = nil
	r.declinedPrepared = append(r.declinedPrepared, declinedPreparedAdoption{
		taskRequestID: adoption.taskRequestID,
		expiresAt:     now + declinedPreparedAdoptionTTL.Milliseconds(),
	})
	if len(r.declinedPrepared) > maxDeclinedPreparedAdoptions {
		r.declinedPrepared = r.declinedPrepared[len(r.declinedPrepared)-maxDeclinedPreparedAdoptions:]
	}
	r.log("session_adoption_expired", map[string]string{"scopeKind": "task"})
	return nil
}

// pruneDeclinedPreparedLocked drops expired fail-closed records. Callers must
// hold r.mu.
func (r *ResidentRuntime) pruneDeclinedPreparedLocked(now int64) {
	kept := r.declinedPrepared[:0]
	for _, record := range r.declinedPrepared {
		if record.expiresAt > now {
			kept = append(kept, record)
		}
	}
	r.declinedPrepared = kept
}

// preparedAdoptionWasDeclined reports whether this exact canonical Task was
// prepared for continuation and then lost its preparation. Such a Task fails
// closed: Free4Chat never substitutes a fresh conversation for a Task the
// Human explicitly asked to continue.
func (r *ResidentRuntime) preparedAdoptionWasDeclined(taskRequestID string) bool {
	if taskRequestID == "" {
		return false
	}
	now := time.Now().UnixMilli()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneDeclinedPreparedLocked(now)
	for _, record := range r.declinedPrepared {
		if record.taskRequestID == taskRequestID {
			return true
		}
	}
	return false
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
	taskRequestID := taskRequestIDForScope(scope)
	r.mu.Lock()
	_, adopted := r.adoptedScopes[scope]
	_, lost := r.adoptedLostScopes[scope]
	adoption := r.expirePreparedAdoptionLocked(time.Now().UnixMilli())
	exact := adoption != nil && adoption.taskRequestID != "" && adoption.taskRequestID == taskRequestID
	r.mu.Unlock()

	if adopted {
		if lost {
			return errAdoptedSessionUnavailable
		}
		// The adapter already retains the loaded session for this scope; this
		// never creates a second conversation.
		return r.ensureHarnessSession(scope)
	}
	if adoption != nil {
		if exact {
			if adoption.claimed {
				// The exact canonical Task already proved ownership when it was
				// accepted into the bounded queue, so the binding is settled.
				// It is never re-derived here: a frozen-context eviction must
				// not be able to turn a prepared Task into a fresh
				// conversation.
				return r.bindSessionAdoption(scope, adoption)
			}
			if !r.adoptionMayBind(scope, target, adoption) {
				// The Task is not the Human's, or is not Human-owned at all.
				// The preparation stays armed for the Task it was pinned to and
				// this scope follows its normal fresh path.
				return r.ensureHarnessSession(scope)
			}
			return r.bindSessionAdoption(scope, adoption)
		}
		if adoption.taskRequestID != "" {
			// EXACT prepared adoption: it may never bind to any other Task,
			// even one that would satisfy the CLI sequence fence.
			return r.ensureHarnessSession(scope)
		}
		if r.adoptionMayBind(scope, target, adoption) {
			return r.bindSessionAdoption(scope, adoption)
		}
		return r.ensureHarnessSession(scope)
	}
	// No adoption is armed. If this exact Task was prepared and then lost its
	// preparation, it fails closed rather than silently starting a new
	// conversation.
	if r.preparedAdoptionWasDeclined(taskRequestID) {
		r.markAdoptedScopeUnavailable(scope)
		return errAdoptedSessionUnavailable
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
	if adoption.modeID != "" {
		r.taskSessionModes[scope] = adoption.modeID
	}
	if len(adoption.configOptions) > 0 {
		r.taskSessionConfig[scope] = cloneNativeControlSelections(adoption.configOptions)
	}
	if adoption.newSession {
		if r.taskProjectCwds == nil {
			r.taskProjectCwds = make(map[string]string)
		}
		r.taskProjectCwds[scope] = cwd
		r.mu.Unlock()
		r.log("task_project_bound", map[string]string{"scopeKind": "task"})
		return r.ensureHarnessSession(scope)
	}
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
	if err := r.applySessionConfigFallbacks(scope); err != nil {
		r.log("task_harness_control_unavailable", map[string]string{"scopeKind": scopeKindOf(scope)})
		return errTaskHarnessControlUnavailable
	}
	if err := r.applyTaskSessionControls(scope); err != nil {
		r.log("task_harness_control_unavailable", map[string]string{"scopeKind": "task"})
		return errTaskHarnessControlUnavailable
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
	r.noteAdoptedScopeLossFor(nil)
}

// noteAdoptedScopeLossFor marks only adopted conversations owned by a failed
// provider process. A nil set preserves the legacy one-process behavior.
func (r *ResidentRuntime) noteAdoptedScopeLossFor(failed map[string]struct{}) {
	r.mu.Lock()
	scopes := make([]string, 0, len(r.adoptedScopes))
	for scope := range r.adoptedScopes {
		if failed != nil {
			if _, ok := failed[scope]; !ok {
				continue
			}
		}
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
