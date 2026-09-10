package runtime

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

type activityUpdate struct {
	scope string
	state types.AgentActivityState
}

type activityClient struct {
	*fakeClient
	mu        sync.Mutex
	updates   []activityUpdate
	started   chan struct{}
	release   chan struct{}
	blockOnce sync.Once
	updateErr error
}

func (c *activityClient) UpdateAgentActivity(_ string, scope string, state types.AgentActivityState) error {
	if c.release != nil {
		c.blockOnce.Do(func() {
			close(c.started)
			<-c.release
		})
	}
	c.mu.Lock()
	c.updates = append(c.updates, activityUpdate{scope: scope, state: state})
	c.mu.Unlock()
	return c.updateErr
}

func (c *activityClient) snapshot() []activityUpdate {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]activityUpdate(nil), c.updates...)
}

func TestResidentActivityCoalescesACPStatesAndClearsOnCompletion(t *testing.T) {
	client := &activityClient{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	runtime := NewResidentRuntime(Options{Client: client})
	runtime.mu.Lock()
	runtime.participantHandle = "private-handle"
	runtime.mu.Unlock()

	runtime.beginActivity("task:request-1")
	select {
	case <-client.started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the first activity publication")
	}
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityThinking)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityThinking)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityUsingTools)
	runtime.finishActivity("task:request-1")
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityResponding)
	close(client.release)

	want := []activityUpdate{
		{scope: "task:request-1", state: types.AgentActivityWorking},
		{scope: "task:request-1", state: ""},
	}
	waitFor(t, time.Second, func() bool {
		return len(client.snapshot()) == len(want)
	}, "coalesced activity updates")
	updates := client.snapshot()
	if len(updates) != len(want) {
		t.Fatalf("activity updates = %#v, want %#v", updates, want)
	}
	for index := range want {
		if updates[index] != want[index] {
			t.Fatalf("activity update %d = %#v, want %#v", index, updates[index], want[index])
		}
	}
}

func TestResidentActivityDoesNotCrossLogicalScopes(t *testing.T) {
	client := &activityClient{}
	runtime := NewResidentRuntime(Options{Client: client})
	runtime.mu.Lock()
	runtime.participantHandle = "private-handle"
	runtime.mu.Unlock()

	runtime.beginActivity("task:request-t")
	runtime.observeHarnessActivity("task:request-u", types.AgentActivityThinking)
	waitFor(t, time.Second, func() bool {
		updates := client.snapshot()
		return len(updates) == 1 && updates[0].scope == "task:request-t"
	}, "room activity publication")
	updates := client.snapshot()
	if len(updates) != 1 || updates[0].scope != "task:request-t" {
		t.Fatalf("cross-scope activity was published: %#v", updates)
	}
	runtime.clearActivity()
}

func TestResidentActivityStartsAtTurnAdmissionAndClearsAfterFailure(t *testing.T) {
	client := &activityClient{
		fakeClient: &fakeClient{},
		started:    make(chan struct{}),
		release:    make(chan struct{}),
	}
	adapter := &fakeAdapter{
		name:     "pi",
		turnErr:  errors.New("harness failed"),
		turnWait: client.started,
	}
	runtime := NewResidentRuntime(Options{
		RoomID:  "room",
		Name:    "Pi",
		Client:  client,
		Adapter: adapter,
	})
	runtime.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "private-handle",
		Cursor:            0,
	})
	runtime.acceptEvent(roomEvent(1, true))
	runtime.drainTurns()
	select {
	case <-client.started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the turn activity publication")
	}
	close(client.release)

	waitFor(t, time.Second, func() bool {
		return len(client.snapshot()) == 2
	}, "failed turn activity lifecycle")
	updates := client.snapshot()
	if len(updates) != 2 ||
		updates[0] != (activityUpdate{scope: "room", state: types.AgentActivityWorking}) ||
		updates[1] != (activityUpdate{scope: "room", state: ""}) {
		t.Fatalf("failed turn activity lifecycle = %#v", updates)
	}
}

func TestResidentActivityPublisherDoesNotBlockTurnPath(t *testing.T) {
	client := &activityClient{
		fakeClient: &fakeClient{},
		started:    make(chan struct{}),
		release:    make(chan struct{}),
		updateErr:  errors.New("activity endpoint failed"),
	}
	adapter := &fakeAdapter{name: "pi", turnErr: errors.New("harness failed")}
	runtime := NewResidentRuntime(Options{
		RoomID:  "room",
		Name:    "Pi",
		Client:  client,
		Adapter: adapter,
	})
	runtime.adoptJoin(types.JoinResult{
		ParticipantID:     "agent",
		ParticipantHandle: "private-handle",
		Cursor:            0,
	})
	runtime.acceptEvent(roomEvent(1, true))

	done := make(chan struct{})
	go func() {
		runtime.drainTurns()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Harness turn path was blocked by the activity endpoint")
	}
	select {
	case <-client.started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the blocked activity endpoint")
	}
	close(client.release)
	waitFor(t, time.Second, func() bool {
		updates := client.snapshot()
		return len(updates) > 0 && updates[len(updates)-1].state == ""
	}, "final activity clear")
}

func TestResidentActivityReconnectRetainsQueuedClear(t *testing.T) {
	client := &activityClient{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	runtime := NewResidentRuntime(Options{Client: client})
	runtime.mu.Lock()
	runtime.participantHandle = "private-handle"
	runtime.mu.Unlock()

	runtime.beginActivity("room")
	select {
	case <-client.started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the in-flight Working publication")
	}

	// Stream loss fail-closes the public state while the old HTTP request is
	// still in flight. A reconnect resets local state but must retain this
	// queued clear because the participant handle remains valid.
	runtime.clearActivity()
	runtime.resetActivityLocal()
	close(client.release)

	waitFor(t, time.Second, func() bool {
		updates := client.snapshot()
		return len(updates) == 2 && updates[1].state == ""
	}, "reconnect activity clear")
	updates := client.snapshot()
	if updates[0] != (activityUpdate{scope: "room", state: types.AgentActivityWorking}) ||
		updates[1] != (activityUpdate{scope: "room", state: ""}) {
		t.Fatalf("reconnect activity lifecycle = %#v", updates)
	}
}
