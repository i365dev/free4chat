package harness

import (
	"encoding/json"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func TestMapACPActivityIsCoarseAndDropsCompletedToolUpdates(t *testing.T) {
	tests := []struct {
		name   string
		update string
		want   types.AgentActivityState
		ok     bool
	}{
		{"thought", `{"update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"private"}}}`, types.AgentActivityThinking, true},
		{"tool", `{"update":{"sessionUpdate":"tool_call","toolCall":{"rawInput":{"command":"secret"}}}}`, types.AgentActivityUsingTools, true},
		{"active tool update", `{"update":{"sessionUpdate":"tool_call_update","status":"in_progress"}}`, types.AgentActivityUsingTools, true},
		{"completed tool update", `{"update":{"sessionUpdate":"tool_call_update","status":"completed"}}`, "", false},
		{"message", `{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"public"}}}`, types.AgentActivityResponding, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := mapACPActivity(json.RawMessage(test.update))
			if got != test.want || ok != test.ok {
				t.Fatalf("mapACPActivity() = %q, %v; want %q, %v", got, ok, test.want, test.ok)
			}
		})
	}
}
