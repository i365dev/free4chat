package runtime

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/i365dev/free4chat/agent/internal/types"
)

type activityUpdate struct {
	scope    string
	state    types.AgentActivityState
	sequence int64
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

func (c *activityClient) UpdateAgentActivity(_ string, scope string, state types.AgentActivityState, turnSequence int64) error {
	if c.release != nil {
		c.blockOnce.Do(func() {
			close(c.started)
			<-c.release
		})
	}
	c.mu.Lock()
	c.updates = append(c.updates, activityUpdate{scope: scope, state: state, sequence: turnSequence})
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

	runtime.beginActivity("task:request-1", 42)
	select {
	case <-client.started:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the first activity publication")
	}
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityThinking)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityThinking)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityUsingTools)
	runtime.finishActivity("task:request-1", 42)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityResponding)
	close(client.release)

	want := []activityUpdate{
		{scope: "task:request-1", state: types.AgentActivityWorking, sequence: 42},
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

	runtime.beginActivity("task:request-t", 7)
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
		updates[0] != (activityUpdate{scope: "room", state: types.AgentActivityWorking, sequence: 1}) ||
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

	runtime.beginActivity("room", 11)
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
	if updates[0] != (activityUpdate{scope: "room", state: types.AgentActivityWorking, sequence: 11}) ||
		updates[1] != (activityUpdate{scope: "room", state: ""}) {
		t.Fatalf("reconnect activity lifecycle = %#v", updates)
	}
}

// TestResidentActivityKeepsExactTurnSequencePerTurn pins the #409 activity
// contract: every state of one turn keeps that turn's canonical sequence, the
// next turn replaces it, and a clear leaves no active turn identity behind.
func TestResidentActivityKeepsExactTurnSequencePerTurn(t *testing.T) {
	client := &activityClient{}
	runtime := NewResidentRuntime(Options{Client: client})
	runtime.mu.Lock()
	runtime.participantHandle = "private-handle"
	runtime.mu.Unlock()

	const scope = "task:request-1"
	published := func(count int) {
		t.Helper()
		waitFor(t, time.Second, func() bool {
			return len(client.snapshot()) == count
		}, "activity publication")
	}
	// #421: the active-turn identity is per scope, so "which turn is running
	// for this scope" is a map lookup rather than three process-global fields.
	activeTurn := func() (bool, string, int64) {
		runtime.activityMu.Lock()
		defer runtime.activityMu.Unlock()
		current, ok := runtime.activities[scope]
		if !ok {
			return false, "", 0
		}
		return true, scope, current.sequence
	}

	runtime.beginActivity(scope, 42)
	published(1)
	for index, state := range []types.AgentActivityState{
		types.AgentActivityThinking,
		types.AgentActivityUsingTools,
		types.AgentActivityResponding,
	} {
		runtime.observeHarnessActivity(scope, state)
		// Wait for each state: the publisher deliberately coalesces a burst
		// into the newest state, and this test is about the sequence each
		// published state carries.
		published(index + 2)
	}

	// The next turn of the same Task replaces the identity with its own exact
	// sequence; the states of turn 42 can no longer be published.
	runtime.finishActivity(scope, 42)
	published(5)
	if active, _, _ := activeTurn(); active {
		t.Fatal("a finished turn must not stay active")
	}
	runtime.observeHarnessActivity(scope, types.AgentActivityThinking)
	runtime.beginActivity(scope, 47)
	published(6)
	runtime.clearActivity()
	published(7)

	if active, activeScope, sequence := activeTurn(); active || activeScope != "" || sequence != 0 {
		t.Fatalf("clearActivity left an active turn identity: %v %q %d", active, activeScope, sequence)
	}

	want := []activityUpdate{
		{scope: scope, state: types.AgentActivityWorking, sequence: 42},
		{scope: scope, state: types.AgentActivityThinking, sequence: 42},
		{scope: scope, state: types.AgentActivityUsingTools, sequence: 42},
		{scope: scope, state: types.AgentActivityResponding, sequence: 42},
		{scope: scope, state: ""},
		{scope: scope, state: types.AgentActivityWorking, sequence: 47},
		{scope: scope, state: ""},
	}
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
