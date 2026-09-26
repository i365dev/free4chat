package runtime

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// pendingTurnContext is an immutable, bounded snapshot of one accepted
// addressed delta. It is deliberately separate from EventBuffer: the latter
// may evict recent transport history, but must never decide whether an
// unacknowledged Harness turn remains retryable.
// steerPromotion is the bounded outcome of one steer-priority decision.
type steerPromotion int

const (
	// steerPromotionMissing: the named instruction is no longer pending work,
	// so there is nothing left to prioritize and the control must not cancel
	// anything.
	steerPromotionMissing steerPromotion = iota
	// steerPromotionAlreadyNext: the instruction is already the next
	// not-yet-started instruction of its Task.
	steerPromotionAlreadyNext
	// steerPromotionMoved: this control reordered the Task's pending work.
	steerPromotionMoved
)

type pendingTurnContext struct {
	after  int64
	target int64
	events []types.RoomEvent
	// steer marks a canonical Human instruction that was explicitly steered
	// (#484). It is a DELIVERY priority only: the instruction stays where the
	// Room put it in canonical history, and this flag lives inside the existing
	// bounded pending map, so it is pruned with the entry it describes.
	steer bool
}

var errScopedHarnessUnsupported = errors.New("scoped Harness adapter is unavailable")

type logicalSessionRef struct {
	deliveredThrough               *int64
	roomDeliveryFloor              *int64
	pendingAddressed               *[]int64
	pendingContexts                *map[int64]pendingTurnContext
	observedHarnessGeneration      *int64
	bootstrappedHarnessGeneration  *int64
	meetingDeliveredThrough        *int64
	meetingDeliveryFloor           *int64
	liveTranscriptDeliveredThrough *int64
	liveTranscriptDeliveryFloor    *int64
	sourceCursors                  *map[string]int64
	// rematerializing marks a scope that was seeded from the released-scope
	// ledger, so its next session edge is the adapter materializing the SAME
	// retained conversation again rather than a replacement conversation.
	rematerializing *bool
}

func normalizeScope(scope string) string {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return ""
	}
	if len(scope) > types.MaxLogicalScopeLength {
		return ""
	}
	return scope
}

func newLogicalSessionState() *logicalSessionState {
	return &logicalSessionState{
		pendingContexts: make(map[int64]pendingTurnContext),
		sourceCursors:   make(map[string]int64),
	}
}

// sessionRefLocked keeps the default Room scope on the existing fields while
// reading an already-admitted task/request scope. It never creates a new
// scope. Callers must hold r.mu.
func (r *ResidentRuntime) sessionRefLocked(scope string) *logicalSessionRef {
	scope = normalizeScope(scope)
	if scope == "" {
		return nil
	}
	if scope == roomScope {
		return &logicalSessionRef{
			deliveredThrough:               &r.deliveredThrough,
			roomDeliveryFloor:              &r.roomDeliveryFloor,
			pendingAddressed:               &r.pendingAddressed,
			pendingContexts:                &r.pendingContexts,
			observedHarnessGeneration:      &r.observedHarnessGeneration,
			bootstrappedHarnessGeneration:  &r.bootstrappedHarnessGeneration,
			meetingDeliveredThrough:        &r.meetingDeliveredThrough,
			meetingDeliveryFloor:           &r.meetingDeliveryFloor,
			liveTranscriptDeliveredThrough: &r.liveTranscriptDeliveredThrough,
			liveTranscriptDeliveryFloor:    &r.liveTranscriptDeliveryFloor,
			sourceCursors:                  nil,
		}
	}
	if r.scopedSessions == nil {
		return nil
	}
	state := r.scopedSessions[scope]
	if state == nil {
		return nil
	}
	return &logicalSessionRef{
		deliveredThrough:               &state.deliveredThrough,
		roomDeliveryFloor:              &state.roomDeliveryFloor,
		pendingAddressed:               &state.pendingAddressed,
		pendingContexts:                &state.pendingContexts,
		observedHarnessGeneration:      &state.observedHarnessGeneration,
		bootstrappedHarnessGeneration:  &state.bootstrappedHarnessGeneration,
		meetingDeliveredThrough:        &state.meetingDeliveredThrough,
		meetingDeliveryFloor:           &state.meetingDeliveryFloor,
		liveTranscriptDeliveredThrough: &state.liveTranscriptDeliveredThrough,
		liveTranscriptDeliveryFloor:    &state.liveTranscriptDeliveryFloor,
		sourceCursors:                  &state.sourceCursors,
		rematerializing:                &state.rematerializing,
	}
}

// ensureSessionRefLocked is the only creation path for non-Room logical
// scopes. A full resident rejects the new scope instead of falling back to
// the Room session or allocating an unbounded local/ACP conversation.
func (r *ResidentRuntime) ensureSessionRefLocked(scope string) (*logicalSessionRef, bool) {
	scope = normalizeScope(scope)
	if scope == "" {
		return nil, false
	}
	if ref := r.sessionRefLocked(scope); ref != nil {
		return ref, true
	}
	if scope == roomScope || len(r.scopeOrder) >= types.MaxLogicalTaskScopes {
		return nil, false
	}
	if r.scopedSessions == nil {
		r.scopedSessions = make(map[string]*logicalSessionState)
	}
	state := newLogicalSessionState()
	// A scope whose conversation the Runtime gave back but can still materialize
	// exactly resumes that SAME conversation: its delivery knowledge and
	// session-generation markers are restored, so the next turn is neither
	// reported as a new conversation nor fed transcripts the conversation
	// already consumed (#473).
	r.adoptReleasedConversationLocked(scope, state)
	r.scopedSessions[scope] = state
	r.scopeOrder = append(r.scopeOrder, scope)
	return &logicalSessionRef{
		deliveredThrough:               &state.deliveredThrough,
		roomDeliveryFloor:              &state.roomDeliveryFloor,
		pendingAddressed:               &state.pendingAddressed,
		pendingContexts:                &state.pendingContexts,
		observedHarnessGeneration:      &state.observedHarnessGeneration,
		bootstrappedHarnessGeneration:  &state.bootstrappedHarnessGeneration,
		meetingDeliveredThrough:        &state.meetingDeliveredThrough,
		meetingDeliveryFloor:           &state.meetingDeliveryFloor,
		liveTranscriptDeliveredThrough: &state.liveTranscriptDeliveredThrough,
		liveTranscriptDeliveryFloor:    &state.liveTranscriptDeliveryFloor,
		sourceCursors:                  &state.sourceCursors,
		rematerializing:                &state.rematerializing,
	}, true
}

func (r *ResidentRuntime) scopeStateExistsLocked(scope string) bool {
	scope = normalizeScope(scope)
	return scope == roomScope || scope != "" && r.scopedSessions != nil && r.scopedSessions[scope] != nil
}

func scopeForRoomEvent(event types.RoomEvent) string {
	if rawScope := strings.TrimSpace(event.ScopeID); rawScope != "" {
		scope := normalizeScope(rawScope)
		if scope == "" {
			return ""
		}
		return scope
	}
	// A bounded action producer may carry the same hint without requiring a
	// wider wire model. taskId is deliberately namespaced so it cannot collide
	// with the default Room conversation.
	if event.ActionPayload != nil {
		if scope := strings.TrimSpace(event.ActionPayload["scopeId"]); scope != "" {
			return normalizeScope("task:" + scope)
		}
		if taskID := strings.TrimSpace(event.ActionPayload["taskId"]); taskID != "" {
			return normalizeScope("task:" + taskID)
		}
	}
	return roomScope
}

// humanTaskRequestFor returns the newest addressed Human-originated Task
// request in this turn's bounded context. Older requests may remain as
// conversational context after a terminal failure, but must never receive a
// later turn's terminal result. Agent-originated requests are excluded.
func humanTaskRequestFor(events []types.RoomEvent, participantID string) *types.WireCollabEvent {
	var newest *types.WireCollabEvent
	var newestSequence int64
	for _, event := range events {
		if !event.Addressed || event.Participant.Kind != types.KindHuman || event.Collab == nil ||
			event.Collab.Kind != types.CollabRequest || event.Collab.TargetParticipantID != participantID ||
			taskRequestIDForScope(scopeForRoomEvent(event)) == "" {
			continue
		}
		if newest == nil || event.Sequence >= newestSequence {
			request := *event.Collab
			newest = &request
			newestSequence = event.Sequence
		}
	}
	return newest
}

func containsSequence(items []int64, sequence int64) bool {
	for _, item := range items {
		if item == sequence {
			return true
		}
	}
	return false
}

func cloneRoomEvents(events []types.RoomEvent) []types.RoomEvent {
	out := make([]types.RoomEvent, len(events))
	copy(out, events)
	return out
}

// currentHandle snapshots the live capability value (internal use only).
func (r *ResidentRuntime) currentHandle() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.participantHandle
}

// currentCursor snapshots the wait cursor.
func (r *ResidentRuntime) currentCursor() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cursor
}

// currentParticipantID snapshots the public participant id.
func (r *ResidentRuntime) currentParticipantID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.participantID
}

func (r *ResidentRuntime) ensureHarnessSession(scope string) error {
	scope = normalizeScope(scope)
	if scope == roomScope {
		if err := r.options.Adapter.EnsureSession(); err != nil {
			return err
		}
		return r.applySessionConfigFallbacks(scope)
	}
	r.mu.Lock()
	projectCwd, projectSelected := r.taskProjectCwdLocked(scope)
	r.mu.Unlock()
	var ensureErr error
	if projectSelected {
		projectAdapter, ok := r.options.Adapter.(types.ScopedProjectHarnessAdapter)
		if !ok {
			return errScopedHarnessUnsupported
		}
		ensureErr = projectAdapter.EnsureSessionForCwd(scope, projectCwd)
	} else if adapter, ok := r.options.Adapter.(types.ScopedHarnessAdapter); ok {
		ensureErr = adapter.EnsureSessionFor(scope)
	} else {
		return errScopedHarnessUnsupported
	}
	if ensureErr != nil {
		return ensureErr
	}
	if err := r.applyTaskSessionControls(scope); err != nil {
		r.log("task_harness_control_unavailable", map[string]string{"scopeKind": "task"})
		return errTaskHarnessControlUnavailable
	}
	if err := r.applySessionConfigFallbacks(scope); err != nil {
		r.log("task_harness_control_unavailable", map[string]string{"scopeKind": "task"})
		return errTaskHarnessControlUnavailable
	}
	return nil
}

func (r *ResidentRuntime) applySessionConfigFallbacks(scope string) error {
	adapter, ok := r.options.Adapter.(types.ScopedHarnessSessionDefaults)
	if !ok {
		return nil
	}
	r.mu.Lock()
	_, selections := r.taskSessionControlsLocked(scope)
	r.mu.Unlock()
	return adapter.ApplySessionConfigFallbacksFor(scope, selections)
}

func (r *ResidentRuntime) applyTaskSessionControls(scope string) error {
	r.mu.Lock()
	modeID, configOptions := r.taskSessionControlsLocked(scope)
	r.mu.Unlock()
	if modeID == "" && len(configOptions) == 0 {
		return nil
	}
	adapter, ok := r.options.Adapter.(types.ScopedHarnessSessionControls)
	if !ok {
		return errScopedHarnessUnsupported
	}
	controls := adapter.SessionControlsFor(scope)
	if controls == nil {
		return errors.New("Harness session controls are unavailable")
	}
	if modeID != "" {
		advertised := false
		for _, mode := range controls.Modes {
			if mode.ID == modeID {
				advertised = true
				break
			}
		}
		if !advertised {
			return errors.New("selected Harness session mode is no longer advertised")
		}
		if controls.CurrentModeID != modeID {
			if err := adapter.SetModeFor(scope, modeID); err != nil {
				return err
			}
			controls = adapter.SessionControlsFor(scope)
			if controls == nil {
				return errors.New("Harness session controls became unavailable")
			}
		}
	}
	for configID, value := range configOptions {
		advertised := false
		for _, option := range controls.ConfigOptions {
			if option.ID != configID || option.Type != "select" {
				continue
			}
			for _, candidate := range option.Options {
				if candidate.Value == value {
					advertised = true
					break
				}
			}
			if advertised && option.CurrentValue == value {
				break
			}
		}
		if !advertised {
			return errors.New("selected Harness session config value is no longer advertised")
		}
		current := ""
		for _, option := range controls.ConfigOptions {
			if option.ID == configID && option.Type == "select" {
				current = option.CurrentValue
				break
			}
		}
		if current != value {
			if err := adapter.SetConfigOptionFor(scope, configID, value); err != nil {
				return err
			}
			controls = adapter.SessionControlsFor(scope)
			if controls == nil {
				return errors.New("Harness session controls became unavailable")
			}
		}
	}
	return nil
}

func (r *ResidentRuntime) harnessSessionGeneration(scope string) (int64, error) {
	scope = normalizeScope(scope)
	if scope == roomScope {
		return r.options.Adapter.SessionGeneration(), nil
	}
	if adapter, ok := r.options.Adapter.(types.ScopedHarnessAdapter); ok {
		return adapter.SessionGenerationFor(scope), nil
	}
	return 0, errScopedHarnessUnsupported
}

func (r *ResidentRuntime) runHarnessTurn(scope string, input types.HarnessTurnInput, generation int64) (types.HarnessTurnResult, error) {
	scope = normalizeScope(scope)
	if scope == roomScope {
		return r.options.Adapter.RunTurn(input, generation)
	}
	if adapter, ok := r.options.Adapter.(types.ScopedHarnessAdapter); ok {
		return adapter.RunTurnFor(scope, input, generation)
	}
	return types.HarnessTurnResult{}, errScopedHarnessUnsupported
}

func (r *ResidentRuntime) isStopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopped
}

func (r *ResidentRuntime) isShuttingDown() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopped || r.admissionsClosed
}

func (r *ResidentRuntime) setState(state State) {
	r.mu.Lock()
	r.state = state
	r.mu.Unlock()
}

// setLastError updates both state and lastError under one lock.
func (r *ResidentRuntime) setStateLastError(state State, message string) {
	r.mu.Lock()
	r.state = state
	r.lastError = message
	r.mu.Unlock()
}

func (r *ResidentRuntime) setLastError(state State, message string) {
	r.mu.Lock()
	r.state = state
	r.lastError = message
	r.mu.Unlock()
}

func (r *ResidentRuntime) pendingAddressedSnapshot() []int64 {
	return r.pendingAddressedSnapshotFor(roomScope)
}

func (r *ResidentRuntime) pendingAddressedSnapshotFor(scope string) []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return nil
	}
	return append([]int64(nil), (*ref.pendingAddressed)...)
}

func (r *ResidentRuntime) pendingScopes() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pendingScopesLocked()
}

// pendingScopesLocked lists the logical scopes holding unacknowledged
// addressed work: the default Room scope first, then scope admission order.
// Callers must hold r.mu.
func (r *ResidentRuntime) pendingScopesLocked() []string {
	if len(r.pendingAddressed) > 0 {
		out := []string{roomScope}
		for _, scope := range r.scopeOrder {
			if state := r.scopedSessions[scope]; state != nil && len(state.pendingAddressed) > 0 {
				out = append(out, scope)
			}
		}
		return out
	}
	var out []string
	for _, scope := range r.scopeOrder {
		if state := r.scopedSessions[scope]; state != nil && len(state.pendingAddressed) > 0 {
			out = append(out, scope)
		}
	}
	return out
}

// nextRunnableTurn returns the canonical turn the bounded drain may execute
// next: the head of the oldest scope holding unacknowledged work whose
// autonomous recovery is still open and which is not ALREADY executing. A
// canonical turn whose recovery is closed stays pending and unacknowledged, so
// it is skipped rather than re-executed or acknowledged; skipping also keeps
// it from blocking another scope's fresh work. Only an explicit recovery
// boundary — a new addressed trigger for that same scope — reopens it (see
// reopenTurnRecoveryLocked).
//
// Excluding already-running scopes is what makes the drain's candidate order
// both fair and terminating under concurrency: every loop iteration either
// claims a scope for execution or finds no further candidate.
func (r *ResidentRuntime) nextRunnableTurn() (string, int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.nextRunnableTurnLocked()
}

// nextRunnableTurnLocked is nextRunnableTurn for callers already holding r.mu.
func (r *ResidentRuntime) nextRunnableTurnLocked() (string, int64, bool) {
	for _, scope := range r.pendingScopesLocked() {
		if r.scopeRunningLocked(scope) {
			continue
		}
		ref := r.sessionRefLocked(scope)
		if ref == nil || len(*ref.pendingAddressed) == 0 {
			continue
		}
		target := (*ref.pendingAddressed)[0]
		if r.turnRecoveryClosedLocked(scope, target) {
			continue
		}
		return scope, target, true
	}
	return "", 0, false
}

// peekPending returns the next addressed target without acknowledging it.
// A target remains retryable until the Harness has successfully consumed the
// corresponding turn; Room transport receipt is deliberately insufficient.
func (r *ResidentRuntime) peekPending() (int64, bool) {
	return r.peekPendingFor(roomScope)
}

func (r *ResidentRuntime) peekPendingFor(scope string) (int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return 0, false
	}
	if len(*ref.pendingAddressed) == 0 {
		return 0, false
	}
	return (*ref.pendingAddressed)[0], true
}

// ackPending removes one successfully-delivered target. It intentionally
// matches by sequence rather than blindly popping so an unexpected queue
// mutation cannot acknowledge a different addressed turn.
func (r *ResidentRuntime) ackPending(sequence int64) {
	r.ackPendingFor(roomScope, sequence)
}

func (r *ResidentRuntime) ackPendingFor(scope string, sequence int64) {
	r.mu.Lock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return
	}
	removed := false
	for index, pending := range *ref.pendingAddressed {
		if pending != sequence {
			continue
		}
		*ref.pendingAddressed = append((*ref.pendingAddressed)[:index], (*ref.pendingAddressed)[index+1:]...)
		delete(*ref.pendingContexts, sequence)
		r.forgetTurnRecoveryLocked(scope, sequence)
		removed = true
		break
	}
	r.mu.Unlock()
	if removed {
		r.publishTaskExecution(scope)
	}
}

func (r *ResidentRuntime) deliveredSeq() int64 {
	return r.deliveredSeqFor(roomScope)
}

func (r *ResidentRuntime) deliveredSeqFor(scope string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return 0
	}
	return *ref.deliveredThrough
}

// effectiveDeliveryStart is the automatic-push boundary. A new ACP session
// deliberately advances its floor to the current trigger without pretending
// the earlier retained Room history was consumed; that history stays pullable.
func (r *ResidentRuntime) effectiveDeliveryStart() int64 {
	return r.effectiveDeliveryStartFor(roomScope)
}

func (r *ResidentRuntime) effectiveDeliveryStartFor(scope string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return 0
	}
	return max(*ref.deliveredThrough, *ref.roomDeliveryFloor)
}

// acknowledgeHarnessDelivery advances the successful Harness-delivery
// cursor only after RunTurn returned successfully, and only then removes the
// addressed trigger. Callers must keep outbound Room reply delivery separate.
func (r *ResidentRuntime) acknowledgeHarnessDelivery(target, through, generation int64) {
	r.acknowledgeHarnessDeliveryFor(roomScope, target, through, generation)
}

func (r *ResidentRuntime) acknowledgeHarnessDeliveryFor(scope string, target, through, generation int64) {
	r.mu.Lock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		r.mu.Unlock()
		return
	}
	removed := false
	if through > *ref.deliveredThrough {
		*ref.deliveredThrough = through
	}
	if generation > 0 && generation == *ref.observedHarnessGeneration {
		*ref.bootstrappedHarnessGeneration = generation
	}
	for index, pending := range *ref.pendingAddressed {
		if pending != target {
			continue
		}
		*ref.pendingAddressed = append((*ref.pendingAddressed)[:index], (*ref.pendingAddressed)[index+1:]...)
		delete(*ref.pendingContexts, target)
		r.forgetTurnRecoveryLocked(scope, target)
		removed = true
		break
	}
	r.mu.Unlock()
	if removed {
		// The consumed trigger is no longer waiting; refresh the transient
		// execution projection outside r.mu (it is presentation only).
		r.publishTaskExecution(scope)
	}
}

func (r *ResidentRuntime) transcriptDeliveryMarkers() (meeting, live int64) {
	return r.transcriptDeliveryMarkersFor(roomScope)
}

func (r *ResidentRuntime) transcriptDeliveryMarkersFor(scope string) (meeting, live int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return 0, 0
	}
	return max(*ref.meetingDeliveryFloor, *ref.meetingDeliveredThrough), max(*ref.liveTranscriptDeliveryFloor, *ref.liveTranscriptDeliveredThrough)
}

func (r *ResidentRuntime) acknowledgeTranscriptDelivery(meeting, live int64) {
	r.acknowledgeTranscriptDeliveryFor(roomScope, meeting, live)
}

func (r *ResidentRuntime) acknowledgeTranscriptDeliveryFor(scope string, meeting, live int64) {
	r.mu.Lock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		r.mu.Unlock()
		return
	}
	if meeting > *ref.meetingDeliveredThrough {
		*ref.meetingDeliveredThrough = meeting
	}
	if live > *ref.liveTranscriptDeliveredThrough {
		*ref.liveTranscriptDeliveredThrough = live
	}
	r.mu.Unlock()
}

// observeHarnessSession records actual ACP session/new replacement. The
// initial session keeps the admission baseline so its first relevant turn
// includes the new Room delta. A later new ACP session intentionally starts
// with its current addressed trigger only; older bounded context stays
// available through the explicit Runtime-mediated history read.
func (r *ResidentRuntime) observeHarnessSession(generation, target int64) bool {
	return r.observeHarnessSessionFor(roomScope, generation, target)
}

func (r *ResidentRuntime) observeHarnessSessionFor(scope string, generation, target int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return false
	}
	if generation <= 0 {
		return false
	}
	if *ref.observedHarnessGeneration == 0 {
		*ref.observedHarnessGeneration = generation
		return *ref.bootstrappedHarnessGeneration != generation
	}
	if *ref.observedHarnessGeneration == generation {
		return *ref.bootstrappedHarnessGeneration != generation
	}
	if ref.rematerializing != nil && *ref.rematerializing {
		// The Runtime gave this scope's exact conversation back and the adapter
		// has now materialized THAT SAME conversation again: a new ACP session
		// object (new generation) over retained conversation memory (#473).
		// Nothing about the conversation restarts, so the Harness is neither
		// told this is a new session nor sent the bootstrap again, no delivery
		// knowledge is reset, and already-consumed transcript segments are not
		// re-injected. Only a conversation whose first Free4Chat turn never
		// happened still reports a session edge, so its bootstrap is delivered.
		consumed := *ref.bootstrappedHarnessGeneration == *ref.observedHarnessGeneration
		*ref.observedHarnessGeneration = generation
		if consumed {
			*ref.bootstrappedHarnessGeneration = generation
		}
		*ref.rematerializing = false
		return !consumed
	}
	*ref.observedHarnessGeneration = generation
	if target > 0 {
		// Reset the current session's actual delivery knowledge. The separate
		// floor suppresses automatic replay of old history, without treating it
		// as acknowledged by a Harness that has never seen it.
		*ref.deliveredThrough = 0
		*ref.roomDeliveryFloor = target - 1
	}
	// A replacement ACP session has no private conversation memory. Keep a
	// floor at the old successful marker so old bounded transcript history is
	// explicitly pull-only, while any segment that failed delivery remains a
	// proactive retry for the new session.
	*ref.meetingDeliveryFloor = max(*ref.meetingDeliveryFloor, *ref.meetingDeliveredThrough)
	*ref.liveTranscriptDeliveryFloor = max(*ref.liveTranscriptDeliveryFloor, *ref.liveTranscriptDeliveredThrough)
	*ref.meetingDeliveredThrough = 0
	*ref.liveTranscriptDeliveredThrough = 0
	return *ref.bootstrappedHarnessGeneration != generation
}

func (r *ResidentRuntime) bufferSince(after, through int64) []types.RoomEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	events := r.eventBuffer.Since(after, through)
	out := make([]types.RoomEvent, len(events))
	copy(out, events)
	return out
}

// pendingContext returns the frozen accepted delta for target. Older Runtime
// state created before this invariant may lack a snapshot; in that narrow
// case recover it from the bounded authenticated Room history rather than
// treating a local EventBuffer eviction as a permanent delivery failure.
func (r *ResidentRuntime) pendingContext(target int64) ([]types.RoomEvent, error) {
	return r.pendingContextFor(roomScope, target)
}

func (r *ResidentRuntime) pendingContextFor(scope string, target int64) ([]types.RoomEvent, error) {
	r.mu.Lock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		r.mu.Unlock()
		return nil, errors.New("logical scope is unavailable")
	}
	pending, ok := (*ref.pendingContexts)[target]
	if !ok {
		start := max(*ref.deliveredThrough, *ref.roomDeliveryFloor)
		pending = pendingTurnContext{
			after:  start,
			target: target,
			events: r.eventsForScopeLocked(scope, start, target),
		}
		if *ref.pendingContexts == nil {
			*ref.pendingContexts = make(map[int64]pendingTurnContext)
		}
		(*ref.pendingContexts)[target] = pending
	}
	if len(pending.events) > 0 {
		events := cloneRoomEvents(pending.events)
		r.mu.Unlock()
		return events, nil
	}
	r.mu.Unlock()

	client, ok := r.options.Client.(types.RoomContextClient)
	if !ok {
		return nil, errors.New("room context read is unavailable")
	}
	handle, err := r.requireHandle()
	if err != nil {
		return nil, err
	}
	cursor := pending.after
	var events []types.RoomEvent
	for cursor < pending.target {
		afterSequence := cursor
		beforeSequence := pending.target + 1
		context, err := client.ReadRoomContext(handle, types.RoomContextReadOptions{
			AfterSequence:  &afterSequence,
			BeforeSequence: &beforeSequence,
			Limit:          50,
		})
		if err != nil {
			return nil, err
		}
		if context.Room.Truncated {
			return nil, fmt.Errorf("room context before sequence %d is no longer retained", cursor)
		}
		last := cursor
		for _, event := range context.Room.Events {
			if event.Sequence > cursor && event.Sequence <= pending.target {
				if scopeForRoomEvent(event) == normalizeScope(scope) {
					events = append(events, event)
				}
				last = event.Sequence
			}
		}
		if last == cursor {
			break
		}
		cursor = last
	}
	if len(events) == 0 {
		return nil, fmt.Errorf("room context for sequence %d is unavailable", pending.target)
	}
	r.mu.Lock()
	ref = r.sessionRefLocked(scope)
	if ref == nil {
		r.mu.Unlock()
		return nil, errors.New("logical scope is unavailable")
	}
	if current, exists := (*ref.pendingContexts)[target]; exists && len(current.events) == 0 {
		current.events = cloneRoomEvents(events)
		(*ref.pendingContexts)[target] = current
	}
	r.mu.Unlock()
	return events, nil
}

func (r *ResidentRuntime) eventsForScopeLocked(scope string, after, through int64) []types.RoomEvent {
	all := r.eventBuffer.Since(after, through)
	scope = normalizeScope(scope)
	filtered := make([]types.RoomEvent, 0, len(all))
	for _, event := range all {
		if scopeForRoomEvent(event) == scope {
			filtered = append(filtered, event)
		}
	}
	return cloneRoomEvents(filtered)
}

// observeLogicalSource records an independent source checkpoint. It is an
// observation only: no pending Room turn is created and no Harness call is
// made. Source adapters can use the same narrow helper when this spike gains
// another bounded source.
func (r *ResidentRuntime) observeLogicalSource(scope, source string, cursor int64) {
	scope = normalizeScope(scope)
	source = strings.TrimSpace(source)
	if source == "" || cursor < 0 {
		return
	}
	r.mu.Lock()
	ref, admitted := r.ensureSessionRefLocked(scope)
	if !admitted || ref == nil {
		r.mu.Unlock()
		return
	}
	if ref.sourceCursors == nil {
		r.mu.Unlock()
		return
	}
	if _, exists := (*ref.sourceCursors)[source]; !exists && len(*ref.sourceCursors) >= types.MaxLogicalSourceCursors {
		r.mu.Unlock()
		return
	}
	if ref.sourceCursors != nil && cursor > (*ref.sourceCursors)[source] {
		(*ref.sourceCursors)[source] = cursor
	}
	r.mu.Unlock()
}

func (r *ResidentRuntime) logicalSourceCursor(scope, source string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return 0
	}
	if ref.sourceCursors == nil {
		return 0
	}
	return (*ref.sourceCursors)[source]
}

func (r *ResidentRuntime) rosterSnapshot() []types.ParticipantRosterEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]types.ParticipantRosterEntry, len(r.roster))
	copy(out, r.roster)
	return out
}

// sleep waits for d or until stop is signalled; returns whether the full
// duration elapsed without a stop signal.
func (r *ResidentRuntime) sleep(d time.Duration) bool {
	select {
	case <-time.After(d):
		return !r.isStopped()
	case <-r.stopCh:
		return false
	}
}

// promoteSteerPendingLocked moves one canonical steer instruction to the front
// of this Task's NOT-YET-STARTED work (#484). It is a delivery-priority
// decision over already-accepted canonical events, never a rewrite of Room
// history or of any Room sequence.
//
// The rules are deliberately small, and each one is load-bearing:
//
//   - the turn that is running right now keeps the head of the queue, so a
//     steer never starts concurrently with it and never cancels it implicitly;
//   - steers already waiting keep their canonical order among themselves, so
//     repeated steering replays in the order the Human wrote it;
//   - ordinary follow-ups keep their FIFO order behind the steers;
//   - nothing crosses a Task boundary: this touches exactly one scope.
//
// It reports how the queue order was decided. Callers must hold r.mu.
func (r *ResidentRuntime) promoteSteerPendingLocked(scope string, sequence int64) steerPromotion {
	ref := r.sessionRefLocked(scope)
	if ref == nil || ref.pendingAddressed == nil || ref.pendingContexts == nil {
		return steerPromotionMissing
	}
	pending := *ref.pendingAddressed
	index := -1
	for position, candidate := range pending {
		if candidate == sequence {
			index = position
			break
		}
	}
	// A steer instruction the Runtime no longer holds as pending work is not
	// promotable: it was either delivered already or refused by the bounded
	// queue. Either way it must never be invented here.
	if index < 0 {
		return steerPromotionMissing
	}
	context, ok := (*ref.pendingContexts)[sequence]
	if !ok {
		return steerPromotionMissing
	}
	context.steer = true
	(*ref.pendingContexts)[sequence] = context

	frontier := 0
	if r.scopeRunningLocked(scope) && len(pending) > 0 {
		// Index 0 is the turn this scope is executing right now.
		frontier = 1
	}
	for frontier < len(pending) && frontier != index {
		entry, ok := (*ref.pendingContexts)[pending[frontier]]
		if !ok || !entry.steer {
			break
		}
		frontier++
	}
	if frontier == index {
		return steerPromotionAlreadyNext
	}
	moved := make([]int64, 0, len(pending))
	moved = append(moved, pending[:index]...)
	moved = append(moved, pending[index+1:]...)
	moved = append(moved, 0)
	copy(moved[frontier+1:], moved[frontier:])
	moved[frontier] = sequence
	*ref.pendingAddressed = moved
	return steerPromotionMoved
}
