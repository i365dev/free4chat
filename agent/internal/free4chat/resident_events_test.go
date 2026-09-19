package free4chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/i365dev/free4chat/agent/internal/types"
)

func residentHandle(room, participant, token string) string {
	payload, _ := json.Marshal(map[string]string{
		"room":             room,
		"participantId":    participant,
		"participantToken": token,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func TestResidentEventStreamUsesHeadersAndDecodesEnvelope(t *testing.T) {
	const token = "private-event-token"
	var requestURL string
	var headers http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestURL = r.URL.String()
		headers = r.Header.Clone()
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		payload, _ := json.Marshal(map[string]any{
			"type": "events",
			"events": []any{map[string]any{
				"sequence": float64(4),
				"type":     "text",
				"participant": map[string]any{
					"id": "human-1", "name": "Ada", "kind": "human",
				},
				"text": "addressed", "addressed": true,
				"createdAt": float64(1700000000000),
			}},
			"cursor":    float64(4),
			"expiresAt": float64(time.Now().Add(time.Hour).UnixMilli()),
			"participants": []any{map[string]any{
				"id": "human-1", "name": "Ada", "kind": "human",
			}},
			"runtimeHosts": map[string]any{
				"11111111-2222-3333-4444-555555555555": map[string]any{
					"runtimeHostId": "11111111-2222-3333-4444-555555555555",
					"speech":        map[string]any{"stt": true, "tts": false},
				},
			},
			"mediaState": map[string]any{
				"meetingNotes":        map[string]any{"active": true, "startedAt": 11},
				"agentVoiceEnabledAt": float64(22),
				"mediaAvailable":      true,
				"liveTranscript": map[string]any{
					"active": true, "producerRuntimeHostId": "host-a", "epoch": float64(7),
				},
			},
		})
		_ = conn.Write(context.Background(), websocket.MessageText, payload)
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", token), 3,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	wait, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatalf("receive resident envelope: %v", err)
	}
	if wait.Cursor != 4 || len(wait.Events) != 1 || !wait.Events[0].Addressed {
		t.Fatalf("event envelope mismatch: %+v", wait)
	}
	if len(wait.Participants) != 1 || wait.Participants[0].ID != "human-1" {
		t.Fatalf("roster envelope mismatch: %+v", wait.Participants)
	}
	host := wait.RuntimeHosts["11111111-2222-3333-4444-555555555555"]
	if !host.Speech.STT || host.Speech.TTS {
		t.Fatalf("runtime host envelope mismatch: %+v", wait.RuntimeHosts)
	}
	if wait.MediaState == nil || !wait.MediaState.MediaAvailable ||
		!wait.MediaState.MeetingNotes.Active || wait.MediaState.AgentVoiceEnabledAt != 22 ||
		!wait.MediaState.LiveTranscript.Active ||
		wait.MediaState.LiveTranscript.ProducerRuntimeHostID != "host-a" ||
		wait.MediaState.LiveTranscript.Epoch != 7 {
		t.Fatalf("media state envelope mismatch: %+v", wait.MediaState)
	}
	if strings.Contains(requestURL, token) || requestURL != "/api/room/agent-events" {
		t.Fatalf("capability leaked into resident URL: %q", requestURL)
	}
	if headers.Get("Authorization") != "Bearer "+token ||
		headers.Get("X-Room-Participant-Token") != token ||
		headers.Get("X-Room-Id") != "room-1" ||
		headers.Get("X-Room-Cursor") != "3" {
		t.Fatalf("resident capability headers mismatch: %v", headers)
	}
}

func TestResidentEventStreamHeartbeatUsesCursor(t *testing.T) {
	seen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		_, payload, err := conn.Read(context.Background())
		if err == nil {
			seen <- string(payload)
		}
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 8,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	if err := stream.Heartbeat(context.Background(), 9); err != nil {
		t.Fatalf("send resident heartbeat: %v", err)
	}
	select {
	case payload := <-seen:
		var message map[string]any
		if err := json.Unmarshal([]byte(payload), &message); err != nil {
			t.Fatal(err)
		}
		if message["type"] != "heartbeat" || message["cursor"] != float64(9) {
			t.Fatalf("heartbeat mismatch: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not receive resident heartbeat")
	}
}

func TestResidentEventStreamAcceptsFramesBeyondCoderDefaultLimit(t *testing.T) {
	const largeText = 40 * 1024
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		payload, _ := json.Marshal(map[string]any{
			"type": "events",
			"events": []any{map[string]any{
				"sequence": float64(1),
				"type":     "text",
				"participant": map[string]any{
					"id": "human-1", "name": "Ada", "kind": "human",
				},
				"text": strings.Repeat("x", largeText), "createdAt": float64(1),
			}},
			"cursor":    float64(1),
			"expiresAt": float64(time.Now().Add(time.Hour).UnixMilli()),
		})
		if len(payload) <= 32*1024 {
			t.Errorf("test frame must exceed coder/websocket default: %d", len(payload))
		}
		if err := conn.Write(context.Background(), websocket.MessageText, payload); err != nil {
			t.Errorf("write large resident envelope: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	wait, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatalf("receive >32 KiB resident envelope: %v", err)
	}
	if len(wait.Events) != 1 || len(wait.Events[0].Text) != largeText {
		t.Fatalf("large resident envelope was truncated: events=%d text=%d", len(wait.Events), len(wait.Events[0].Text))
	}
}

func TestResidentEventStreamAcceptsNearMaximumCatchupEnvelope(t *testing.T) {
	const eventCount = 100
	const eventText = 4000
	events := make([]any, 0, eventCount)
	for sequence := 1; sequence <= eventCount; sequence++ {
		events = append(events, map[string]any{
			"sequence": float64(sequence),
			"type":     "text",
			"participant": map[string]any{
				"id": "human-1", "name": strings.Repeat("A", 32), "kind": "human",
			},
			"text": strings.Repeat("界", eventText), "createdAt": float64(sequence),
		})
	}
	participants := make([]any, 0, 64)
	for index := 0; index < 64; index++ {
		participants = append(participants, map[string]any{
			"id": fmt.Sprintf("human-%03d", index), "name": strings.Repeat("N", 32), "kind": "human",
		})
	}
	runtimeHosts := make(map[string]any, 32)
	for index := 0; index < 32; index++ {
		id := fmt.Sprintf("host-%04d", index)
		runtimeHosts[id] = map[string]any{
			"runtimeHostId": id,
			"speech":        map[string]any{"stt": true, "tts": true},
		}
	}
	payload, err := json.Marshal(map[string]any{
		"type":         "events",
		"events":       events,
		"cursor":       float64(eventCount),
		"expiresAt":    float64(time.Now().Add(time.Hour).UnixMilli()),
		"participants": participants,
		"runtimeHosts": runtimeHosts,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) <= 1<<20 || len(payload) > maxResidentEventBytes {
		t.Fatalf("near-maximum test payload has unexpected size: %d", len(payload))
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		if err := conn.Write(context.Background(), websocket.MessageText, payload); err != nil {
			t.Errorf("write near-maximum resident envelope: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	wait, err := stream.Receive(context.Background())
	if err != nil {
		t.Fatalf("receive near-maximum resident envelope: %v", err)
	}
	if wait.Cursor != eventCount || len(wait.Events) != eventCount || len(wait.Participants) != 64 || len(wait.RuntimeHosts) != 32 {
		t.Fatalf("near-maximum resident envelope mismatch: cursor=%d events=%d participants=%d hosts=%d", wait.Cursor, len(wait.Events), len(wait.Participants), len(wait.RuntimeHosts))
	}
}

func TestResidentEventStreamClassifiesOversizeEnvelopeAsTerminal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		payload := []byte(`{"type":"error","error":"event_envelope_too_large"}`)
		if err := conn.Write(context.Background(), websocket.MessageText, payload); err != nil {
			t.Errorf("write resident protocol error: %v", err)
		}
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	_, err = stream.Receive(context.Background())
	if CodeOf(err) != CodeToolError {
		t.Fatalf("oversize envelope must be terminal, got %v", err)
	}
}

func TestResidentEventStreamClassifiesTransportOversizeAsTerminal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		// This is intentionally larger than the application maximum and the
		// client's one-byte classification allowance, so coder/websocket must
		// close it with StatusMessageTooBig.
		_ = conn.Write(
			context.Background(),
			websocket.MessageText,
			[]byte(strings.Repeat("x", maxResidentEventBytes+2)),
		)
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	_, err = stream.Receive(context.Background())
	if CodeOf(err) != CodeToolError {
		t.Fatalf("transport-oversize frame must be terminal, got %v", err)
	}
}

func TestResidentEventStreamClassifiesUnauthorizedHandshake(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	_, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if CodeOf(err) != CodeInvalidParticipantHandle {
		t.Fatalf("unauthorized handshake classification: %v", err)
	}
}

func TestJoinResultParsesServerAgentLease(t *testing.T) {
	client, _ := newTestClient(t, func(w http.ResponseWriter, body map[string]any) {
		if toolNameOf(body) == "join_room" {
			writeJSON(w, callResult(map[string]any{
				"participantHandle": "h",
				"participant":       map[string]any{"id": "agent"},
				"cursor":            float64(0),
				"expiresAt":         float64(100),
				"agentLeaseMs":      float64(90000),
			}))
			return
		}
		respondToolsList(w)
	})
	joined, err := client.JoinRoom("room", "Agent", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if joined.AgentLeaseMs != 90000 {
		t.Fatalf("server lease not retained: %+v", joined)
	}
}

var _ types.ResidentEventClient = (*Client)(nil)

// receiveResidentFrame serves exactly one resident frame and returns what the
// client decoded from it.
func receiveResidentFrame(t *testing.T, frame map[string]any) (types.WaitResult, error) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		payload, _ := json.Marshal(frame)
		_ = conn.Write(context.Background(), websocket.MessageText, payload)
		// Close from the server side too, so the test does not pay the client's
		// close-handshake timeout on every case.
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}))
	t.Cleanup(server.Close)

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()
	return stream.Receive(context.Background())
}

// TestResidentEventStreamDecodesPrivateTaskControl proves the #409 control
// frame is decoded into the private resident projection only: it is not a Room
// event, it carries no cursor, and it cannot leak into a public/MCP-shaped
// WaitResult.
func TestResidentEventStreamDecodesPrivateTaskControl(t *testing.T) {
	wait, err := receiveResidentFrame(t, map[string]any{
		"type":          "task-control",
		"control":       "interrupt",
		"taskRequestId": "req-T-0001",
		"turnSequence":  42,
	})
	if err != nil {
		t.Fatalf("decode private task control: %v", err)
	}
	if wait.TaskControl == nil ||
		wait.TaskControl.Kind != types.ResidentTaskControlInterrupt ||
		wait.TaskControl.TaskRequestID != "req-T-0001" ||
		wait.TaskControl.TurnSequence != 42 {
		t.Fatalf("private task control mismatch: %+v", wait.TaskControl)
	}
	if wait.Cursor != 0 || len(wait.Events) != 0 || wait.MediaState != nil || wait.Participants != nil {
		t.Fatalf("a task control must not be projected as a Room event: %+v", wait)
	}
	encoded, err := json.Marshal(wait)
	if err != nil {
		t.Fatalf("marshal resident wait result: %v", err)
	}
	for _, forbidden := range []string{"taskControl", "taskRequestId", "req-T-0001", "task-control", "interrupt", "turnSequence"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("private task control leaked into a serialized wait result (%q): %s", forbidden, encoded)
		}
	}
}

// TestResidentEventStreamRejectsMalformedTaskControl proves a malformed or
// oversized control fails closed instead of degrading into an ordinary Room
// event or a silent no-op.
func TestResidentEventStreamRejectsMalformedTaskControl(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		frame map[string]any
	}{
		{name: "unsupported control", frame: map[string]any{
			"type": "task-control", "control": "steer", "taskRequestId": "req-T-0001", "turnSequence": 42,
		}},
		{name: "missing control", frame: map[string]any{
			"type": "task-control", "taskRequestId": "req-T-0001", "turnSequence": 42,
		}},
		{name: "missing task request", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "turnSequence": 42,
		}},
		{name: "padded task request", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": " req-T-0001 ", "turnSequence": 42,
		}},
		{name: "control rune in task request", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": "req\tT", "turnSequence": 42,
		}},
		{name: "oversized task request", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": strings.Repeat("t", 65), "turnSequence": 42,
		}},
		// #409 exact-turn identity: a control must name one positive, safe turn.
		{name: "missing turn sequence", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": "req-T-0001",
		}},
		{name: "zero turn sequence", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": "req-T-0001", "turnSequence": 0,
		}},
		{name: "negative turn sequence", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": "req-T-0001", "turnSequence": -7,
		}},
		{name: "unsafe turn sequence", frame: map[string]any{
			"type": "task-control", "control": "interrupt", "taskRequestId": "req-T-0001",
			"turnSequence": int64(types.MaxResidentTurnSequence) + 1,
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			wait, err := receiveResidentFrame(t, testCase.frame)
			if err == nil {
				t.Fatalf("malformed task control must fail closed: %+v", wait)
			}
			if CodeOf(err) != CodeToolError {
				t.Fatalf("want a tool-protocol error, got %v", err)
			}
			if wait.TaskControl != nil || len(wait.Events) != 0 || wait.Cursor != 0 {
				t.Fatalf("malformed control was partially applied: %+v", wait)
			}
		})
	}
}

// TestResidentEventStreamDecodesPrivateSessionControl proves the #409 session
// control family is decoded into the private resident projection only: it is
// not a Room event, carries no cursor, and can never leak into a
// public/MCP-shaped WaitResult.
func TestResidentEventStreamDecodesPrivateSessionControl(t *testing.T) {
	list, err := receiveResidentFrame(t, map[string]any{
		"type":               "task-session-control",
		"operation":          "list",
		"requestId":          "req-list-0001",
		"humanParticipantId": "human-1",
		"projectToken":       "project-token-1",
		"pageToken":          "page-token-1",
	})
	if err != nil {
		t.Fatalf("decode private session list control: %v", err)
	}
	if list.SessionControl == nil ||
		list.SessionControl.Kind != types.ResidentSessionControlList ||
		list.SessionControl.RequestID != "req-list-0001" ||
		list.SessionControl.HumanParticipantID != "human-1" ||
		list.SessionControl.ProjectToken != "project-token-1" ||
		list.SessionControl.PageToken != "page-token-1" {
		t.Fatalf("private session list control mismatch: %+v", list.SessionControl)
	}
	if list.Cursor != 0 || len(list.Events) != 0 || list.MediaState != nil ||
		list.Participants != nil || list.TaskControl != nil {
		t.Fatalf("a session control must not be projected as a Room event: %+v", list)
	}
	encoded, err := json.Marshal(list)
	if err != nil {
		t.Fatalf("marshal resident wait result: %v", err)
	}
	for _, forbidden := range []string{
		"sessionControl", "projectToken", "pageToken", "sessionToken",
		"project-token-1", "page-token-1", "task-session-control", "human-1",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("private session control leaked into a serialized wait result (%q): %s", forbidden, encoded)
		}
	}

	prepare, err := receiveResidentFrame(t, map[string]any{
		"type":               "task-session-control",
		"operation":          "prepare",
		"requestId":          "req-prepare-0001",
		"humanParticipantId": "human-1",
		"sessionToken":       "session-token-1",
		"taskRequestId":      "req-A-0001",
	})
	if err != nil {
		t.Fatalf("decode private session prepare control: %v", err)
	}
	if prepare.SessionControl == nil ||
		prepare.SessionControl.Kind != types.ResidentSessionControlPrepare ||
		prepare.SessionControl.SessionToken != "session-token-1" ||
		prepare.SessionControl.TaskRequestID != "req-A-0001" {
		t.Fatalf("private session prepare control mismatch: %+v", prepare.SessionControl)
	}

	cancel, err := receiveResidentFrame(t, map[string]any{
		"type":               "task-session-control",
		"operation":          "cancel",
		"requestId":          "req-cancel-0001",
		"humanParticipantId": "human-1",
		"taskRequestId":      "req-A-0001",
	})
	if err != nil {
		t.Fatalf("decode private session cancel control: %v", err)
	}
	if cancel.SessionControl == nil ||
		cancel.SessionControl.Kind != types.ResidentSessionControlCancel ||
		cancel.SessionControl.TaskRequestID != "req-A-0001" {
		t.Fatalf("private session cancel control mismatch: %+v", cancel.SessionControl)
	}
}

// TestResidentEventStreamRejectsMalformedSessionControl proves a malformed
// session control fails closed: it is neither degraded into an ordinary Room
// event nor partially applied.
func TestResidentEventStreamRejectsMalformedSessionControl(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		frame map[string]any
	}{
		{name: "unsupported operation", frame: map[string]any{
			"type": "task-session-control", "operation": "browse", "requestId": "req-1", "humanParticipantId": "human-1",
		}},
		{name: "missing operation", frame: map[string]any{
			"type": "task-session-control", "requestId": "req-1", "humanParticipantId": "human-1",
		}},
		{name: "missing request id", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "humanParticipantId": "human-1",
		}},
		{name: "padded request id", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": " req-1 ", "humanParticipantId": "human-1",
		}},
		{name: "oversized request id", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": strings.Repeat("r", 65), "humanParticipantId": "human-1",
		}},
		// Every operation is Human-scoped: an unbound control can never be
		// widened into "anyone".
		{name: "missing human", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": "req-1",
		}},
		{name: "padded human", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": "req-1", "humanParticipantId": " human-1 ",
		}},
		{name: "oversized token", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": "req-1",
			"humanParticipantId": "human-1", "projectToken": strings.Repeat("t", 129),
		}},
		{name: "control rune in token", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": "req-1",
			"humanParticipantId": "human-1", "pageToken": "page\t1",
		}},
		{name: "prepare without a session token", frame: map[string]any{
			"type": "task-session-control", "operation": "prepare", "requestId": "req-1",
			"humanParticipantId": "human-1", "taskRequestId": "req-A-0001",
		}},
		{name: "prepare without a task request", frame: map[string]any{
			"type": "task-session-control", "operation": "prepare", "requestId": "req-1",
			"humanParticipantId": "human-1", "sessionToken": "session-token-1",
		}},
		{name: "list carrying a session token", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": "req-1",
			"humanParticipantId": "human-1", "sessionToken": "session-token-1",
		}},
		{name: "list carrying a task request", frame: map[string]any{
			"type": "task-session-control", "operation": "list", "requestId": "req-1",
			"humanParticipantId": "human-1", "taskRequestId": "req-A-0001",
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			wait, err := receiveResidentFrame(t, testCase.frame)
			if err == nil {
				t.Fatalf("malformed session control must fail closed: %+v", wait)
			}
			if CodeOf(err) != CodeToolError {
				t.Fatalf("want a tool-protocol error, got %v", err)
			}
			if wait.SessionControl != nil || len(wait.Events) != 0 || wait.Cursor != 0 {
				t.Fatalf("malformed control was partially applied: %+v", wait)
			}
		})
	}
}

// TestResidentEventStreamSendsBoundedSessionResult proves the ONLY outbound
// session frame shape, and that an oversized result fails closed into one
// minimal error result rather than a truncated page.
func TestResidentEventStreamSendsBoundedSessionResult(t *testing.T) {
	seen := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept resident stream: %v", err)
			return
		}
		// The oversized case deliberately exceeds the default 32 KiB read
		// limit; raise it here so the frame is actually observable.
		conn.SetReadLimit(maxResidentEventBytes + 1)
		for index := 0; index < 2; index++ {
			_, payload, readErr := conn.Read(context.Background())
			if readErr != nil {
				return
			}
			seen <- string(payload)
		}
	}))
	t.Cleanup(server.Close)
	nextFrame := func() string {
		t.Helper()
		select {
		case payload := <-seen:
			return payload
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for an outbound resident frame")
			return ""
		}
	}

	client := New(server.URL + "/mcp")
	stream, err := client.OpenResidentEventStream(
		context.Background(), residentHandle("room-1", "agent-1", "token"), 0,
	)
	if err != nil {
		t.Fatalf("open resident stream: %v", err)
	}
	defer stream.Close()

	if err := stream.SendSessionResult(context.Background(), types.ResidentSessionResult{
		Kind:      types.ResidentSessionControlList,
		RequestID: "req-list-0001",
		OK:        true,
		Sessions: []types.ResidentTaskSession{{
			Token:        "session-token-1",
			Title:        "Native Pi conversation",
			ProjectToken: "project-token-1",
			ProjectLabel: "/private/tmp",
			UpdatedAt:    "2026-09-19T10:00:00Z",
		}},
		Projects:      []types.ResidentTaskSessionProject{{Token: "project-token-1", Label: "/private/tmp"}},
		NextPageToken: "page-token-1",
		HasMore:       true,
	}); err != nil {
		t.Fatalf("send session result: %v", err)
	}
	var frame map[string]any
	if err := json.Unmarshal([]byte(nextFrame()), &frame); err != nil {
		t.Fatalf("decode session result frame: %v", err)
	}
	if frame["type"] != "task-session-result" ||
		frame["operation"] != "list" ||
		frame["requestId"] != "req-list-0001" ||
		frame["ok"] != true ||
		frame["nextPageToken"] != "page-token-1" ||
		frame["hasMore"] != true {
		t.Fatalf("session result frame mismatch: %v", frame)
	}
	if _, hasCursor := frame["cursor"]; hasCursor {
		t.Fatalf("a session result must never carry a Room cursor: %v", frame)
	}
	rows, ok := frame["sessions"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("session rows mismatch: %v", frame["sessions"])
	}

	// An oversized page fails closed into ONE minimal error result.
	huge := make([]types.ResidentTaskSession, 0, 200)
	for index := 0; index < 200; index++ {
		huge = append(huge, types.ResidentTaskSession{
			Token:        strings.Repeat("t", 64),
			Title:        strings.Repeat("x", 256),
			ProjectToken: strings.Repeat("p", 64),
			ProjectLabel: strings.Repeat("y", 256),
		})
	}
	if err := stream.SendSessionResult(context.Background(), types.ResidentSessionResult{
		Kind:      types.ResidentSessionControlList,
		RequestID: "req-list-0002",
		OK:        true,
		Sessions:  huge,
	}); err != nil {
		t.Fatalf("send oversized session result: %v", err)
	}
	var fallback map[string]any
	if err := json.Unmarshal([]byte(nextFrame()), &fallback); err != nil {
		t.Fatalf("decode fallback frame: %v", err)
	}
	if fallback["ok"] != false ||
		fallback["error"] != string(types.ResidentSessionErrorUnavailable) ||
		fallback["requestId"] != "req-list-0002" {
		t.Fatalf("an oversized result must fail closed: %v", fallback)
	}
	if _, hasRows := fallback["sessions"]; hasRows {
		t.Fatalf("a failed-closed result must carry no rows: %v", fallback)
	}
}
