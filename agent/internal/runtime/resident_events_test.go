package runtime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

type residentTestStream struct {
	results    chan types.WaitResult
	closed     chan struct{}
	closeOnce  sync.Once
	heartbeats chan int64
}

func newResidentTestStream() *residentTestStream {
	return &residentTestStream{
		results:    make(chan types.WaitResult, 4),
		closed:     make(chan struct{}),
		heartbeats: make(chan int64, 16),
	}
}

func (s *residentTestStream) Receive(ctx context.Context) (types.WaitResult, error) {
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

func (c *residentTestClient) JoinRoom(roomID, name string, capabilities []string, host *types.RuntimeHostProjection) (types.JoinResult, error) {
	joined, err := c.fakeClient.JoinRoom(roomID, name, capabilities, host)
	joined.AgentLeaseMs = 30
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
