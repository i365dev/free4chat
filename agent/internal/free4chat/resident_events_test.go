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
	joined, err := client.JoinRoom("room", "Agent", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if joined.AgentLeaseMs != 90000 {
		t.Fatalf("server lease not retained: %+v", joined)
	}
}

var _ types.ResidentEventClient = (*Client)(nil)
