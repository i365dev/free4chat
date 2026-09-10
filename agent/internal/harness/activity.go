package harness

import (
	"encoding/json"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// mapACPActivity projects only the ACP update kind/status. Raw ACP content is
// intentionally not returned or retained by this mapper.
func mapACPActivity(params json.RawMessage) (types.AgentActivityState, bool) {
	var document struct {
		Update struct {
			SessionUpdate string `json:"sessionUpdate"`
			Status        string `json:"status"`
			ToolCall      struct {
				Status string `json:"status"`
			} `json:"toolCall"`
			ToolCallUpdate struct {
				Status string `json:"status"`
			} `json:"toolCallUpdate"`
		} `json:"update"`
	}
	if json.Unmarshal(params, &document) != nil {
		return "", false
	}
	switch document.Update.SessionUpdate {
	case "agent_thought_chunk":
		return types.AgentActivityThinking, true
	case "agent_message_chunk":
		return types.AgentActivityResponding, true
	case "tool_call":
		return types.AgentActivityUsingTools, true
	case "tool_call_update":
		status := strings.ToLower(strings.TrimSpace(document.Update.Status))
		if status == "" {
			status = strings.ToLower(strings.TrimSpace(document.Update.ToolCallUpdate.Status))
		}
		if status == "completed" || status == "complete" || status == "failed" ||
			status == "cancelled" || status == "canceled" || status == "rejected" ||
			status == "done" {
			return "", false
		}
		return types.AgentActivityUsingTools, true
	default:
		return "", false
	}
}
