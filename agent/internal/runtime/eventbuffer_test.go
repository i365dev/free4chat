package runtime

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func roomEvent(sequence int64, addressed bool) types.RoomEvent {
	return types.RoomEvent{
		Sequence:    sequence,
		Type:        "text",
		Participant: types.ParticipantIdentity{ID: "human", Name: "Human", Kind: types.KindHuman},
		Text:        "message-" + itoa(sequence),
		Addressed:   addressed,
		CreatedAt:   sequence,
	}
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	var out []byte
	negative := value < 0
	if negative {
		value = -value
	}
	for value > 0 {
		out = append([]byte{byte('0' + value%10)}, out...)
		value /= 10
	}
	if negative {
		return "-" + string(out)
	}
	return string(out)
}

func TestEventBufferBounded(t *testing.T) {
	buffer := NewEventBuffer(2, 10_000)
	buffer.Add(roomEvent(1, false))
	buffer.Add(roomEvent(2, false))
	buffer.Add(roomEvent(3, false))

	snapshot := buffer.Snapshot()
	if len(snapshot) != 2 || snapshot[0].Sequence != 2 || snapshot[1].Sequence != 3 {
		t.Fatalf("bounded eviction failed: %+v", snapshot)
	}
}

func TestEventBufferCharBoundEvictsOldest(t *testing.T) {
	first := roomEvent(1, false)
	first.Text = strings.Repeat("x", 200)
	second := roomEvent(2, false)
	second.Text = strings.Repeat("y", 300)
	wireFirst := mustJSONStringOf(first)
	wireSecond := mustJSONStringOf(second)
	limit := len(wireSecond)
	if len(wireFirst)+len(wireSecond) <= limit {
		t.Fatalf("test setup must exceed the bound")
	}
	buffer := NewEventBuffer(50, limit)
	buffer.Add(first)
	if len(buffer.Snapshot()) != 1 {
		t.Fatalf("first event must fit: %+v", buffer.Snapshot())
	}
	buffer.Add(second)
	got := buffer.Snapshot()
	if len(got) != 1 || got[0].Sequence != 2 {
		t.Fatalf("char bound must evict oldest: %+v", got)
	}
}

func mustJSONStringOf(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func TestEventBufferSinceWindow(t *testing.T) {
	buffer := NewEventBuffer(0, 0)
	for i := int64(1); i <= 5; i++ {
		buffer.Add(roomEvent(i, false))
	}
	got := buffer.Since(2, 4)
	if len(got) != 2 || got[0].Sequence != 3 || got[1].Sequence != 4 {
		t.Fatalf("since window mismatch: %+v", got)
	}
}

func TestBoundedPushKeepsLastK(t *testing.T) {
	var values []int64
	for i := 0; i < 10; i++ {
		values = BoundedPush(values, int64(i), 8)
	}
	if values[0] != 2 || values[len(values)-1] != 9 || len(values) != 8 {
		t.Fatalf("pending bound mismatch: %v", values)
	}
}

func TestRetryDelayMatchesNodeReference(t *testing.T) {
	if RetryDelay(0).String() != "1s" {
		t.Fatalf("attempt 0 delay: %s", RetryDelay(0))
	}
	if RetryDelay(20).String() != "10s" {
		t.Fatalf("cap violated: %s", RetryDelay(20))
	}
	ladder := []time.Duration{
		time.Second, 2 * time.Second, 4 * time.Second,
		8 * time.Second, 10 * time.Second, 10 * time.Second,
	}
	for attempt, want := range ladder {
		if got := RetryDelay(attempt); got != want {
			t.Fatalf("attempt %d: got %s want %s", attempt, got, want)
		}
	}
}

func TestBuildHarnessTurnNeverCarriesCapability(t *testing.T) {
	input := BuildHarnessTurn([]types.RoomEvent{roomEvent(1, true)}, nil)
	jsonText := mustJSON(t, input)
	if strings.Contains(jsonText, "participantHandle") ||
		strings.Contains(jsonText, "secret") {
		t.Fatalf("capability leaked into turn input: %s", jsonText)
	}
	if len(input.Events) != 1 || input.Events[0].Sender != "Human" {
		t.Fatalf("event projection mismatch: %+v", input.Events)
	}
	if !input.Room.Ephemeral {
		t.Fatal("ephemeral flag lost")
	}
}

func TestBuildHarnessTurnProjectsCollabAndSelf(t *testing.T) {
	events := []types.RoomEvent{{
		Sequence:    7,
		Type:        "action",
		Participant: types.ParticipantIdentity{ID: "agent-1", Name: "Pi", Kind: types.KindAgent},
		ActionType:  "collab",
		Collab: &types.WireCollabEvent{
			RequestID:           "req-1",
			Kind:                types.CollabRequest,
			FromParticipantID:   "agent-1",
			TargetParticipantID: "agent-2",
			Summary:             "audit logs",
			AttachmentIDs:       []string{"att-1"},
		},
		Addressed: true,
		CreatedAt: 9,
	}}
	input := BuildHarnessTurn(events, &TurnContextOptions{
		Self: &types.RoomSelfContext{InstanceID: "inst-1", ParticipantID: "agent-2", Name: "Codex"},
	})
	view := input.Events[0]
	if view.Collab == nil || view.Collab.FromName != "Pi" || view.Collab.RequestID != "req-1" {
		t.Fatalf("collab projection mismatch: %+v", view.Collab)
	}
	if input.Room.Self == nil || input.Room.Self.InstanceID != "inst-1" {
		t.Fatalf("self context missing: %+v", input.Room.Self)
	}
}
