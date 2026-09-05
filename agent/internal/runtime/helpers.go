package runtime

import (
	"errors"
	"fmt"
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
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int64(nil), r.pendingAddressed...)
}

// peekPending returns the next addressed target without acknowledging it.
// A target remains retryable until the Harness has successfully consumed the
// corresponding turn; Room transport receipt is deliberately insufficient.
func (r *ResidentRuntime) peekPending() (int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pendingAddressed) == 0 {
		return 0, false
	}
	return r.pendingAddressed[0], true
}

// ackPending removes one successfully-delivered target. It intentionally
// matches by sequence rather than blindly popping so an unexpected queue
// mutation cannot acknowledge a different addressed turn.
func (r *ResidentRuntime) ackPending(sequence int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for index, pending := range r.pendingAddressed {
		if pending != sequence {
			continue
		}
		r.pendingAddressed = append(r.pendingAddressed[:index], r.pendingAddressed[index+1:]...)
		delete(r.pendingContexts, sequence)
		return
	}
}

func (r *ResidentRuntime) deliveredSeq() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.deliveredThrough
}

// effectiveDeliveryStart is the automatic-push boundary. A new ACP session
// deliberately advances its floor to the current trigger without pretending
// the earlier retained Room history was consumed; that history stays pullable.
func (r *ResidentRuntime) effectiveDeliveryStart() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return max(r.deliveredThrough, r.roomDeliveryFloor)
}

// acknowledgeHarnessDelivery advances the successful Harness-delivery
// cursor only after RunTurn returned successfully, and only then removes the
// addressed trigger. Callers must keep outbound Room reply delivery separate.
func (r *ResidentRuntime) acknowledgeHarnessDelivery(target, through, generation int64) {
	r.mu.Lock()
	if through > r.deliveredThrough {
		r.deliveredThrough = through
	}
	if generation > 0 && generation == r.observedHarnessGeneration {
		r.bootstrappedHarnessGeneration = generation
	}
	for index, pending := range r.pendingAddressed {
		if pending != target {
			continue
		}
		r.pendingAddressed = append(r.pendingAddressed[:index], r.pendingAddressed[index+1:]...)
		delete(r.pendingContexts, target)
		break
	}
	r.mu.Unlock()
}

func (r *ResidentRuntime) transcriptDeliveryMarkers() (meeting, live int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return max(r.meetingDeliveryFloor, r.meetingDeliveredThrough), max(r.liveTranscriptDeliveryFloor, r.liveTranscriptDeliveredThrough)
}

func (r *ResidentRuntime) acknowledgeTranscriptDelivery(meeting, live int64) {
	r.mu.Lock()
	if meeting > r.meetingDeliveredThrough {
		r.meetingDeliveredThrough = meeting
	}
	if live > r.liveTranscriptDeliveredThrough {
		r.liveTranscriptDeliveredThrough = live
	}
	r.mu.Unlock()
}

// observeHarnessSession records actual ACP session/new replacement. The
// initial session keeps the admission baseline so its first relevant turn
// includes the new Room delta. A later new ACP session intentionally starts
// with its current addressed trigger only; older bounded context stays
// available through the explicit Runtime-mediated history read.
func (r *ResidentRuntime) observeHarnessSession(generation, target int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if generation <= 0 {
		return false
	}
	if r.observedHarnessGeneration == 0 {
		r.observedHarnessGeneration = generation
		return r.bootstrappedHarnessGeneration != generation
	}
	if r.observedHarnessGeneration == generation {
		return r.bootstrappedHarnessGeneration != generation
	}
	r.observedHarnessGeneration = generation
	if target > 0 {
		// Reset the current session's actual delivery knowledge. The separate
		// floor suppresses automatic replay of old history, without treating it
		// as acknowledged by a Harness that has never seen it.
		r.deliveredThrough = 0
		r.roomDeliveryFloor = target - 1
	}
	// A replacement ACP session has no private conversation memory. Keep a
	// floor at the old successful marker so old bounded transcript history is
	// explicitly pull-only, while any segment that failed delivery remains a
	// proactive retry for the new session.
	r.meetingDeliveryFloor = max(r.meetingDeliveryFloor, r.meetingDeliveredThrough)
	r.liveTranscriptDeliveryFloor = max(r.liveTranscriptDeliveryFloor, r.liveTranscriptDeliveredThrough)
	r.meetingDeliveredThrough = 0
	r.liveTranscriptDeliveredThrough = 0
	return r.bootstrappedHarnessGeneration != generation
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
	r.mu.Lock()
	pending, ok := r.pendingContexts[target]
	if !ok {
		start := max(r.deliveredThrough, r.roomDeliveryFloor)
		pending = pendingTurnContext{
			after:  start,
			target: target,
			events: cloneRoomEvents(r.eventBuffer.Since(start, target)),
		}
		if r.pendingContexts == nil {
			r.pendingContexts = make(map[int64]pendingTurnContext)
		}
		r.pendingContexts[target] = pending
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
				events = append(events, event)
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
	if current, exists := r.pendingContexts[target]; exists && len(current.events) == 0 {
		current.events = cloneRoomEvents(events)
		r.pendingContexts[target] = current
	}
	r.mu.Unlock()
	return events, nil
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
