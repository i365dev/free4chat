package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/free4chat"
	"github.com/i365dev/free4chat/agent/internal/types"
)

type residentTestStream struct {
	results    chan types.WaitResult
	closed     chan struct{}
	closeOnce  sync.Once
	heartbeats chan int64
	receiveErr error
}

func newResidentTestStream() *residentTestStream {
	return &residentTestStream{
		results:    make(chan types.WaitResult, 4),
		closed:     make(chan struct{}),
		heartbeats: make(chan int64, 16),
	}
}

func (s *residentTestStream) Receive(ctx context.Context) (types.WaitResult, error) {
	if s.receiveErr != nil {
		return types.WaitResult{}, s.receiveErr
	}
	select {
	case result := <-s.results:
		return result, nil
	case <-s.closed:
		return types.WaitResult{}, errors.New("resident test stream closed")
	case <-ctx.Done():
		return types.WaitResult{}, ctx.Err()
	}
}

func (s *residentTestStream) Heartbeat(ctx context.Context, cursor int64) error {
	select {
	case s.heartbeats <- cursor:
		return nil
	case <-s.closed:
		return errors.New("resident test stream closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *residentTestStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

type residentTestClient struct {
	*fakeClient
	streams       chan *residentTestStream
	mu            sync.Mutex
	openCount     int
	openCursors   []int64
	openParticIDs []string
}

type parsedLeaseResidentClient struct {
	*free4chat.Client
	stream types.ResidentEventStream
}

func (c *parsedLeaseResidentClient) OpenResidentEventStream(
	context.Context,
	string,
	int64,
) (types.ResidentEventStream, error) {
	return c.stream, nil
}

func (c *residentTestClient) JoinRoom(roomID, name string, capabilities []string, host *types.RuntimeHostProjection) (types.JoinResult, error) {
	joined, err := c.fakeClient.JoinRoom(roomID, name, capabilities, host)
	joined.AgentLeaseMs = 30 // Deliberately differs from the 90s compatibility fallback.
	return joined, err
}

func (c *residentTestClient) OpenResidentEventStream(
	ctx context.Context,
	participantHandle string,
	cursor int64,
) (types.ResidentEventStream, error) {
	c.mu.Lock()
	c.openCount++
	c.openCursors = append(c.openCursors, cursor)
	c.openParticIDs = append(c.openParticIDs, participantHandle)
	c.mu.Unlock()
	select {
	case stream := <-c.streams:
		return stream, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *residentTestClient) residentOpenSnapshot() (int, []int64, []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.openCount, append([]int64(nil), c.openCursors...), append([]string(nil), c.openParticIDs...)
}

func TestResidentRuntimeUsesEventStreamAndSparseLeaseHeartbeat(t *testing.T) {
	stream := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	adapter := &fakeAdapter{name: "pi"}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-stream",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    adapter,
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	if got := rt.residentHeartbeatInterval(); got != 10*time.Millisecond {
		t.Fatalf("server lease was not converted to one-third heartbeat: %s", got)
	}
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream open")
	stream.results <- types.WaitResult{
		Events: []types.RoomEvent{roomEvent(1, true)},
		Cursor: 1, ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	waitFor(t, time.Second, func() bool { return len(client.snapshotSent()) == 1 }, "resident reply")
	waitFor(t, time.Second, func() bool { return len(stream.heartbeats) > 0 }, "lease heartbeat")
	client.mu.Lock()
	open := client.openCount
	client.mu.Unlock()
	client.fakeClient.mu.Lock()
	waits := client.fakeClient.waits
	client.fakeClient.mu.Unlock()
	if open != 1 || waits != 0 {
		t.Fatalf("resident Runtime must use the event stream only: opens=%d waits=%d", open, waits)
	}
	rt.Stop()
	select {
	case <-stream.closed:
	case <-time.After(time.Second):
		t.Fatal("Stop did not close the resident event stream")
	}
}

func TestResidentRuntimeUsesLeaseParsedFromMCPJoin(t *testing.T) {
	const leaseMs = 30
	handlePayload, err := json.Marshal(map[string]string{
		"room":             "room",
		"participantId":    "agent-1",
		"participantToken": "token-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	participantHandle := base64.RawURLEncoding.EncodeToString(handlePayload)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode MCP request: %v", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if body.Method == "tools/list" {
			tools := make([]map[string]string, 0, 16)
			for _, name := range []string{
				"room_info", "read_room_context", "join_room", "create_room", "wait_for_events",
				"send_text", "read_attachment", "leave_room", "update_capabilities",
				"send_collab_request", "send_collab_response", "send_collab_result",
				"send_attachment", "publish_surface", "clear_surface", "read_surface",
			} {
				tools = append(tools, map[string]string{"name": name})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": 1,
				"result": map[string]any{"tools": tools},
			})
			return
		}
		payload := map[string]any{}
		if body.Method == "tools/call" && body.Params.Name == "join_room" {
			payload = map[string]any{
				"participantHandle": participantHandle,
				"participant":       map[string]any{"id": "agent-1"},
				"cursor":            float64(0),
				"expiresAt":         float64(time.Now().Add(time.Hour).UnixMilli()),
				"agentLeaseMs":      float64(leaseMs),
			}
		}
		text, _ := json.Marshal(payload)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{
				"content": []any{map[string]any{"type": "text", "text": string(text)}},
			},
		})
	}))
	t.Cleanup(server.Close)

	stream := newResidentTestStream()
	client := &parsedLeaseResidentClient{
		Client: free4chat.New(server.URL),
		stream: stream,
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-parsed-lease",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	if got := rt.residentHeartbeatInterval(); got != 10*time.Millisecond {
		t.Fatalf("MCP lease was not parsed into heartbeat interval: %s", got)
	}
	waitFor(t, time.Second, func() bool { return len(stream.heartbeats) > 0 }, "parsed lease heartbeat")
	rt.Stop()
}

func TestResidentRuntimeReconnectPreservesParticipantAndCursor(t *testing.T) {
	first := newResidentTestStream()
	second := newResidentTestStream()
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 2),
	}
	client.streams <- first
	client.streams <- second
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-reconnect",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "first resident stream open")
	first.results <- types.WaitResult{
		Cursor: 7, ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	_ = first.Close()
	waitFor(t, 3*time.Second, func() bool {
		open, cursors, _ := client.residentOpenSnapshot()
		return open >= 2 && len(cursors) >= 2 && cursors[1] == 7
	}, "cursor-preserving resident reconnect")
	open, cursors, handles := client.residentOpenSnapshot()
	if open < 2 || cursors[0] != 0 || cursors[1] != 7 || handles[0] != handles[1] {
		t.Fatalf("reconnect lost resident identity/cursor: opens=%d cursors=%v", open, cursors)
	}
	client.fakeClient.mu.Lock()
	joins := client.fakeClient.joins
	client.fakeClient.mu.Unlock()
	if joins != 1 {
		t.Fatalf("transient stream close must not create a new participant: joins=%d", joins)
	}
	rt.Stop()
}

func TestResidentRuntimeDoesNotReconnectAfterTerminalEventProtocolError(t *testing.T) {
	stream := newResidentTestStream()
	stream.receiveErr = &free4chat.Error{
		Message: "resident event stream rejected the event envelope",
		Code:    free4chat.CodeToolError,
	}
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream, 1),
	}
	client.streams <- stream
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-terminal-frame",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		return rt.Status().State == StateStopped
	}, "terminal resident protocol error")
	open, _, _ := client.residentOpenSnapshot()
	if open != 1 {
		t.Fatalf("terminal resident protocol error must not reconnect: opens=%d", open)
	}
	rt.Stop()
}

func TestResidentRuntimeStopCancelsEventStreamHandshake(t *testing.T) {
	client := &residentTestClient{
		fakeClient: &fakeClient{},
		streams:    make(chan *residentTestStream),
	}
	rt := NewResidentRuntime(Options{
		InstanceID: "resident-stop-handshake",
		RoomID:     "room",
		Name:       "Agent",
		Client:     client,
		Adapter:    &fakeAdapter{name: "pi"},
	})
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool {
		open, _, _ := client.residentOpenSnapshot()
		return open == 1
	}, "resident event stream handshake")

	done := make(chan struct{})
	go func() {
		rt.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel the resident event stream handshake")
	}
}
