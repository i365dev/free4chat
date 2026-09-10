package runtime

import (
	"errors"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

type activityUpdate struct {
	scope string
	state types.AgentActivityState
}

type activityClient struct {
	*fakeClient
	updates []activityUpdate
}

func (c *activityClient) UpdateAgentActivity(_ string, scope string, state types.AgentActivityState) error {
	c.updates = append(c.updates, activityUpdate{scope: scope, state: state})
	return nil
}

func TestResidentActivityCoalescesACPStatesAndClearsOnCompletion(t *testing.T) {
	client := &activityClient{}
	runtime := NewResidentRuntime(Options{Client: client})
	runtime.mu.Lock()
	runtime.participantHandle = "private-handle"
	runtime.mu.Unlock()

	runtime.beginActivity("task:request-1")
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityThinking)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityThinking)
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityUsingTools)
	runtime.finishActivity("task:request-1")
	runtime.observeHarnessActivity("task:request-1", types.AgentActivityResponding)

	want := []activityUpdate{
		{scope: "task:request-1", state: types.AgentActivityWorking},
		{scope: "task:request-1", state: types.AgentActivityThinking},
		{scope: "task:request-1", state: types.AgentActivityUsingTools},
		{scope: "task:request-1", state: ""},
	}
	if len(client.updates) != len(want) {
		t.Fatalf("activity updates = %#v, want %#v", client.updates, want)
	}
	for index := range want {
		if client.updates[index] != want[index] {
			t.Fatalf("activity update %d = %#v, want %#v", index, client.updates[index], want[index])
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
	if len(client.updates) != 1 || client.updates[0].scope != "task:request-t" {
		t.Fatalf("cross-scope activity was published: %#v", client.updates)
	}
	runtime.clearActivity()
}

func TestResidentActivityStartsAtTurnAdmissionAndClearsAfterFailure(t *testing.T) {
	client := &activityClient{fakeClient: &fakeClient{}}
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
	runtime.drainTurns()

	if len(client.updates) != 2 ||
		client.updates[0] != (activityUpdate{scope: "room", state: types.AgentActivityWorking}) ||
		client.updates[1] != (activityUpdate{scope: "room", state: ""}) {
		t.Fatalf("failed turn activity lifecycle = %#v", client.updates)
	}
}
