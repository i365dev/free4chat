package harness

import (
	"strings"

	"github.com/i365dev/free4chat/agent/internal/generatedapp"
	"github.com/i365dev/free4chat/agent/internal/types"
)

const (
	taskOutputOpen  = "[[free4chat:task-output generated-app]]"
	taskOutputClose = "[[/free4chat:task-output]]"
)

// ParseHarnessTurnResult extracts the one Task-native Generated App result
// from an ACP text turn, then applies the existing strict Runtime control
// parsers. The marker payload is ordinary bounded HTML; it is normalized to
// the existing internal bundle contract before publication.
func ParseHarnessTurnResult(text, taskRequestID string) types.HarnessTurnResult {
	original := strings.TrimSpace(text)
	body := original
	var app *types.GeneratedTaskAppOutput
	if taskRequestID != "" {
		if parsedBody, bundle, ok := parseGeneratedAppOutput(original); ok {
			body = parsedBody
			app = &types.GeneratedTaskAppOutput{Bundle: bundle}
		}
	}
	if app == nil && (strings.Contains(original, taskOutputOpen) || strings.Contains(original, taskOutputClose)) {
		// A malformed, out-of-scope, or non-terminal Task output block must not
		// be reinterpreted as a separate lifecycle/target control.
		return types.HarnessTurnResult{Text: original}
	}
	body, targets, lifecycle := ParseOutboundResult(body)
	if app != nil && (len(targets) > 0 || lifecycle != types.LifecycleIntentNone) {
		// One turn may produce either a Task App or an existing Runtime
		// control, never both. Preserve the full reply as ordinary text.
		return types.HarnessTurnResult{Text: original}
	}
	return types.HarnessTurnResult{
		Text:                 body,
		TargetParticipantIDs: targets,
		LifecycleIntent:      lifecycle,
		GeneratedApp:         app,
	}
}

func parseGeneratedAppOutput(text string) (string, map[string]any, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasSuffix(trimmed, taskOutputClose) {
		return text, nil, false
	}
	open := strings.Index(trimmed, taskOutputOpen)
	if open < 0 || strings.Contains(trimmed[open+len(taskOutputOpen):], taskOutputOpen) {
		return text, nil, false
	}
	encoded := strings.TrimSpace(trimmed[open+len(taskOutputOpen) : len(trimmed)-len(taskOutputClose)])
	bundle, err := generatedapp.NormalizeHTML(encoded)
	if err != nil {
		return text, nil, false
	}
	return strings.TrimSpace(trimmed[:open]), bundle, true
}
