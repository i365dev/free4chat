package runtime

import (
	"encoding/json"

	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	defaultMaxEvents = 50
	defaultMaxChars  = 32_000
)

// EventBuffer is the bounded room-event history kept for building Harness
// turns: at most maxEvents events and at most maxChars total JSON length,
// mirroring the Node reference exactly.
type EventBuffer struct {
	events    []types.RoomEvent
	maxEvents int
	maxChars  int
}

// NewEventBuffer builds a bounded buffer (defaults 50 events / 32k chars).
func NewEventBuffer(maxEvents, maxChars int) *EventBuffer {
	if maxEvents <= 0 {
		maxEvents = defaultMaxEvents
	}
	if maxChars <= 0 {
		maxChars = defaultMaxChars
	}
	return &EventBuffer{maxEvents: maxEvents, maxChars: maxChars}
}

func wireLength(events []types.RoomEvent) int {
	total := 0
	for i := range events {
		data, err := json.Marshal(events[i])
		if err != nil {
			continue
		}
		total += len(data)
	}
	return total
}

// Add appends an event, evicting oldest entries until both bounds hold.
func (b *EventBuffer) Add(event types.RoomEvent) {
	b.events = append(b.events, event)
	for len(b.events) > b.maxEvents || wireLength(b.events) > b.maxChars {
		b.events = b.events[1:]
	}
}

// Since returns buffered events with sequence in (after, through].
func (b *EventBuffer) Since(after, through int64) []types.RoomEvent {
	var result []types.RoomEvent
	for _, event := range b.events {
		if event.Sequence > after && event.Sequence <= through {
			result = append(result, event)
		}
	}
	return result
}

// Snapshot copies the current buffered events.
func (b *EventBuffer) Snapshot() []types.RoomEvent {
	out := make([]types.RoomEvent, len(b.events))
	copy(out, b.events)
	return out
}

// Clear drops everything (used on every fresh join adoption).
func (b *EventBuffer) Clear() {
	b.events = nil
}

// BoundedPush appends an item, evicting from the front beyond maxItems.
func BoundedPush[T any](items []T, item T, maxItems int) []T {
	items = append(items, item)
	for len(items) > maxItems {
		items = items[1:]
	}
	return items
}
