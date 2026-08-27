package runtime

import (
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

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

// popPending removes and returns the next queued addressed target.
func (r *ResidentRuntime) popPending() (int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.pendingAddressed) == 0 {
		return 0, false
	}
	next := r.pendingAddressed[0]
	r.pendingAddressed = r.pendingAddressed[1:]
	return next, true
}

func (r *ResidentRuntime) lastSeq() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastHarnessSequence
}

func (r *ResidentRuntime) setLastSeq(sequence int64) {
	r.mu.Lock()
	r.lastHarnessSequence = sequence
	r.mu.Unlock()
}

func (r *ResidentRuntime) bufferSince(after, through int64) []types.RoomEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	events := r.eventBuffer.Since(after, through)
	out := make([]types.RoomEvent, len(events))
	copy(out, events)
	return out
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
