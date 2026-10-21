package free4chat

import (
	"os"
	"testing"
)

// Run explicitly against a real local Worker or the released endpoint. The
// ordinary unit suite skips this network contract instead of claiming it ran.
func TestWorkerMCPContract(t *testing.T) {
	endpoint := os.Getenv("FREE4CHAT_MCP_CONTRACT_ENDPOINT")
	if endpoint == "" {
		t.Skip("set FREE4CHAT_MCP_CONTRACT_ENDPOINT to execute the real Worker contract")
	}
	a := New(endpoint)
	if err := a.Connect(); err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	created, err := a.CreateRoom("Migration probe A", nil, nil)
	if err != nil {
		t.Fatalf("create_room: %v", err)
	}
	t.Cleanup(func() {
		if err := a.LeaveRoom(created.ParticipantHandle); err != nil {
			t.Errorf("leave_room A: %v", err)
		}
	})
	b := New(endpoint)
	if err := b.Connect(); err != nil {
		t.Fatalf("second client tools/list: %v", err)
	}
	joined, err := b.JoinRoom(created.Invite.RoomID, "Migration probe B", nil, nil, nil)
	if err != nil {
		t.Fatalf("join_room: %v", err)
	}
	t.Cleanup(func() {
		if err := b.LeaveRoom(joined.ParticipantHandle); err != nil {
			t.Errorf("leave_room B: %v", err)
		}
	})
	info, err := a.RoomInfo(created.Invite.RoomID)
	if err != nil || !info.Exists || len(info.Participants) != 2 {
		t.Fatalf("room_info did not observe both participants (error: %v)", err)
	}
	const message = "MCP framework migration contract probe"
	sent, err := a.SendText(created.ParticipantHandle, message, nil)
	if err != nil || sent.Sequence <= 0 {
		t.Fatalf("send_text: %v", err)
	}
	events, err := b.WaitForEvents(joined.ParticipantHandle, joined.Cursor, 0)
	if err != nil {
		t.Fatalf("wait_for_events: %v", err)
	}
	for _, event := range events.Events {
		if event.Text == message && event.Sequence == sent.Sequence {
			t.Log("executed real Go client -> Worker -> RoomSession: list/create/join/read/write/read/leave")
			return
		}
	}
	t.Fatal("second client did not read the committed message")
}
