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
type pendingTurnContext struct {
	after  int64
	target int64
	events []types.RoomEvent
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
		return r.options.Adapter.EnsureSession()
	}
	if adapter, ok := r.options.Adapter.(types.ScopedHarnessAdapter); ok {
		return adapter.EnsureSessionFor(scope)
	}
	return errScopedHarnessUnsupported
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
	defer r.mu.Unlock()
	ref := r.sessionRefLocked(scope)
	if ref == nil {
		return
	}
	for index, pending := range *ref.pendingAddressed {
		if pending != sequence {
			continue
		}
		*ref.pendingAddressed = append((*ref.pendingAddressed)[:index], (*ref.pendingAddressed)[index+1:]...)
		delete(*ref.pendingContexts, sequence)
		return
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
		break
	}
	r.mu.Unlock()
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
