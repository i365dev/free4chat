package harness

import (
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// lifecycleLeaveEnvelope is a deliberately closed Harness-to-Runtime
// lifecycle control. It is not Room text, an MCP command, or a general
// Runtime-control grammar: leave is the only action the local Runtime can
// receive from a Harness result.
const lifecycleLeaveEnvelope = "[[free4chat:lifecycle leave]]"

// ParseOutboundResult extracts one strict outbound control from a completed
// Harness reply. Existing targets behavior is preserved exactly. A lifecycle
// intent is recognized only as the final complete line; if an otherwise valid
// targets envelope is also present, both controls fail closed and the full
// reply remains ordinary visible prose.
func ParseOutboundResult(text string) (string, []string, types.LifecycleIntent) {
	body, lifecycle := parseLifecycleIntent(text)
	if lifecycle != types.LifecycleIntentNone {
		// A reply must choose exactly one control surface. Detect a preceding
		// valid targets envelope through its existing strict parser rather than
		// adding a second targets grammar here.
		if _, targets := ParseOutboundTargets(body); len(targets) > 0 {
			return strings.TrimSpace(text), nil, types.LifecycleIntentNone
		}
		return body, nil, lifecycle
	}
	body, targets := ParseOutboundTargets(text)
	return body, targets, types.LifecycleIntentNone
}

// parseLifecycleIntent recognizes only the exact terminal lifecycle line.
// Approximate, quoted, embedded, or extended forms remain visible ordinary
// prose. It intentionally performs no natural-language interpretation.
func parseLifecycleIntent(text string) (string, types.LifecycleIntent) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", types.LifecycleIntentNone
	}
	lines := strings.Split(trimmed, "\n")
	if lines[len(lines)-1] != lifecycleLeaveEnvelope {
		return trimmed, types.LifecycleIntentNone
	}
	body := strings.TrimSpace(strings.Join(lines[:len(lines)-1], "\n"))
	return body, types.LifecycleIntentLeave
}
