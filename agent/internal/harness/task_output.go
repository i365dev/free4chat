package harness

import (
	"bytes"
	"encoding/json"
	"io"
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
// parsers. ACP's session/prompt result has no portable artifact field, so the
// output uses a closed, size-bounded block in the standard message text.
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
	if len(encoded) == 0 || len(encoded) > generatedapp.MaxBundleBytes {
		return text, nil, false
	}
	decoder := json.NewDecoder(bytes.NewBufferString(encoded))
	decoder.DisallowUnknownFields()
	var bundle map[string]any
	if err := decoder.Decode(&bundle); err != nil {
		return text, nil, false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return text, nil, false
	}
	compact, err := json.Marshal(bundle)
	if err != nil || generatedapp.Validate(compact, bundle) != nil {
		return text, nil, false
	}
	return strings.TrimSpace(trimmed[:open]), bundle, true
}
