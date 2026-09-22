package harness

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// hygieneAnchor is the stable label of the public reply contract. Tests assert
// on this anchor plus coarse semantic markers, never on exact prose, so the
// contract can be reworded without breaking the regression guard.
const hygieneAnchor = "Public Room reply contract:"

// liveViewDescribeHint is the machine-authority affordance a Harness must use
// instead of searching local source, docs, or binary strings.
const liveViewDescribeHint = runtimeCommand + " live-view describe --json"

func bootstrapPromptInput() *types.HarnessTurnInput {
	return &types.HarnessTurnInput{
		Room: types.RoomTurnContext{
			Ephemeral: true,
			Self:      &types.RoomSelfContext{Name: "Agent", InstanceID: "inst-prompt"},
			Participants: []types.ParticipantRosterEntry{{
				ID: "human-1", Name: "Ada", Kind: types.KindHuman,
			}},
		},
		Events: []types.HarnessEvent{{
			Sender: "Ada", Kind: types.KindHuman, Text: "Please build the Live View.",
			Addressed: true, Sequence: 1,
		}},
		Session: &types.HarnessSessionContext{New: true, CurrentRoomSequence: 1},
	}
}

func TestBootstrapPromptCarriesPublicReplyHygieneContract(t *testing.T) {
	bootstrap := RenderUntrustedRoomTurn(bootstrapPromptInput())
	index := strings.Index(bootstrap, hygieneAnchor)
	if index < 0 {
		t.Fatalf("bootstrap prompt is missing the public reply contract anchor:\n%s", bootstrap)
	}
	block := bootstrap[index:]
	for _, marker := range []string{"public reply", "tools", "activity", "concise"} {
		if !strings.Contains(block, marker) {
			t.Fatalf("public reply contract lost the %q guarantee:\n%s", marker, block)
		}
	}

	// The contract is a stable bootstrap instruction, not a per-turn repeat:
	// a retained-session delta must stay bounded and must not re-teach it.
	deltaInput := bootstrapPromptInput()
	deltaInput.Session = &types.HarnessSessionContext{New: false, CurrentRoomSequence: 4}
	delta := RenderUntrustedRoomTurn(deltaInput)
	if strings.Contains(delta, hygieneAnchor) {
		t.Fatalf("the stable reply contract must not repeat on every delta turn:\n%s", delta)
	}
	if len(delta) >= len(bootstrap) {
		t.Fatalf("delta prompt (%d bytes) must stay smaller than bootstrap (%d bytes)", len(delta), len(bootstrap))
	}
}

// TestTaskScopedTurnStatesTheExactTaskRequestIDAffordance pins the #421
// dogfood fix E: a Task turn must name its own canonical requestId and the
// exact correlated attach command, and a Room turn must not gain that
// affordance (an unscoped attach stays a Room artifact).
func TestTaskScopedTurnStatesTheExactTaskRequestIDAffordance(t *testing.T) {
	const requestID = "req-task-42"
	input := bootstrapPromptInput()
	input.TaskRequestID = requestID
	prompt := RenderUntrustedRoomTurn(input)
	if !strings.Contains(prompt, "Current Task requestId: "+requestID) {
		t.Fatalf("task turn must state the exact Task requestId:\n%s", prompt)
	}
	expectedAttach := runtimeCommand + " attach --file <path> --task-request-id " + requestID
	if !strings.Contains(prompt, expectedAttach) {
		t.Fatalf("task turn must state the exact correlated attach command %q:\n%s", expectedAttach, prompt)
	}

	// The affordance is per-turn, not a bootstrap-only lesson: a delta turn of
	// the same Task must repeat the concrete id.
	deltaInput := bootstrapPromptInput()
	deltaInput.Session = &types.HarnessSessionContext{New: false, CurrentRoomSequence: 9}
	deltaInput.TaskRequestID = requestID
	delta := RenderUntrustedRoomTurn(deltaInput)
	if !strings.Contains(delta, "Current Task requestId: "+requestID) {
		t.Fatalf("task delta turn must repeat the exact Task requestId:\n%s", delta)
	}

	// An ordinary Room turn carries no Task id, so the unscoped attach remains
	// the truthful Room artifact path.
	room := RenderUntrustedRoomTurn(bootstrapPromptInput())
	if strings.Contains(room, "Current Task requestId:") {
		t.Fatalf("a Room turn must not claim a Task scope:\n%s", room)
	}
}

func TestLiveViewAffordancePointsAtRuntimeDescribeCommand(t *testing.T) {
	bootstrap := RenderUntrustedRoomTurn(bootstrapPromptInput())
	if !strings.Contains(bootstrap, liveViewDescribeHint) {
		t.Fatalf("bootstrap prompt must point the Harness at %s", liveViewDescribeHint)
	}
	describe := bootstrap[strings.Index(bootstrap, liveViewDescribeHint):]
	if !strings.Contains(describe, "do not search") {
		t.Fatalf("the Live View affordance must forbid local schema searching:\n%s", describe)
	}
	// The existing small starter example remains available.
	if !strings.Contains(bootstrap, `"surfaceId":"counter"`) {
		t.Fatal("the starter Live View example was dropped from the affordance")
	}
}

func TestTaskScopedTurnCarriesCompactGeneratedAppAffordance(t *testing.T) {
	input := bootstrapPromptInput()
	input.TaskRequestID = "req-task-app"
	prompt := RenderUntrustedRoomTurn(input)
	for _, marker := range []string{
		runtimeCommand + " generated-app describe --json",
		runtimeCommand + " generated-app publish --task-request-id req-task-app --file <bundle.json>",
		"one bounded collaborative Task App",
		"do not publish a second App for the same Task",
	} {
		if !strings.Contains(prompt, marker) {
			t.Fatalf("Task prompt missing generated App marker %q:\n%s", marker, prompt)
		}
	}
	roomPrompt := RenderUntrustedRoomTurn(bootstrapPromptInput())
	if strings.Contains(roomPrompt, "generated-app describe") {
		t.Fatalf("Room-scoped prompt must not carry the Task App affordance:\n%s", roomPrompt)
	}
}

// TestThoughtFilteringAndCoarseActivityProjectionUnchanged pins the two
// existing behaviors the #364 D contract deliberately relies on instead of
// adding a heuristic text filter: private thought chunks never accumulate into
// the public reply, and progress stays the coarse activity projection.
func TestThoughtFilteringAndCoarseActivityProjectionUnchanged(t *testing.T) {
	thought := json.RawMessage(`{
	  "sessionId": "s",
	  "update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "SECRET-THINKING"}}
	}`)
	if text, ok := extractTextChunk(thought); ok || text != "" {
		t.Fatalf("thought chunk must stay out of the public reply: ok=%v text=%q", ok, text)
	}
	if state, ok := mapACPActivity(thought); !ok || state != types.AgentActivityThinking {
		t.Fatalf("thought progress must stay a coarse activity state: %q %v", state, ok)
	}
	tool := json.RawMessage(`{"update":{"sessionUpdate":"tool_call","toolCall":{"rawInput":{"command":"secret"}}}}`)
	if state, ok := mapACPActivity(tool); !ok || state != types.AgentActivityUsingTools {
		t.Fatalf("tool progress must stay a coarse activity state: %q %v", state, ok)
	}
}

// TestAssistantMessageNarrationIsNotFilteredFromThePublicReply proves the
// Runtime still applies no English/regex filtering to assistant-message text:
// the reply hygiene contract is a prompt contract, not a text filter.
func TestAssistantMessageNarrationIsNotFilteredFromThePublicReply(t *testing.T) {
	const narration = "Let me search the local config and binary strings for the Live View schema. Step 1: grep the source tree."
	adapter, _ := newTestAdapter(t, scriptLauncher("envelope", map[string]string{
		"FAKE_REPLY_TEXT": narration,
	}), AdapterOptions{})
	defer adapter.Close()
	if err := adapter.EnsureSession(); err != nil {
		t.Fatalf("ensure failed: %v", err)
	}
	result, err := adapter.RunTurn(turnInput("build the Live View"), adapter.SessionGeneration())
	if err != nil {
		t.Fatalf("turn failed: %v", err)
	}
	if result.Text != narration {
		t.Fatalf("assistant-message text must pass through verbatim, got %q", result.Text)
	}
}
