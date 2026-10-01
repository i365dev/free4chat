package harness

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func validTaskAppJSON(t *testing.T) string {
	t.Helper()
	bundle := map[string]any{
		"version":      float64(1),
		"manifest":     map[string]any{"title": "Printer", "networkOrigins": []any{}},
		"html":         "<main id=status>Loading</main>",
		"css":          "main { font: 16px sans-serif; }",
		"js":           "document.querySelector('#status').textContent='Ready';",
		"initialState": map[string]any{"status": "unknown"},
	}
	encoded, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestParseHarnessTurnResultExtractsBoundedGeneratedTaskApp(t *testing.T) {
	jsonBundle := validTaskAppJSON(t)
	text := "Printer status app is ready.\n" + taskOutputOpen + "\n" + jsonBundle + "\n" + taskOutputClose
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.Text != "Printer status app is ready." || result.GeneratedApp == nil {
		t.Fatalf("Task App result was not separated from the public reply: %+v", result)
	}
	if result.GeneratedApp.Bundle["version"] != float64(1) {
		t.Fatalf("Task App bundle did not survive parsing: %#v", result.GeneratedApp.Bundle)
	}
}

func TestParseHarnessTurnResultAcceptsInlineAndPrettyPrintedGeneratedTaskApp(t *testing.T) {
	jsonBundle := validTaskAppJSON(t)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(jsonBundle), "", "  "); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		text string
	}{
		{
			name: "inline opening marker",
			text: taskOutputOpen + " " + jsonBundle + "\n" + taskOutputClose,
		},
		{
			name: "pretty printed JSON",
			text: taskOutputOpen + "\n\t" + pretty.String() + "\n\t" + taskOutputClose,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := ParseHarnessTurnResult(test.text, "req-printer")
			if result.GeneratedApp == nil || result.Text != "" {
				t.Fatalf("Task App output was not extracted: %+v", result)
			}
		})
	}
}

func TestParseHarnessTurnResultPreservesHumanReplyBeforeGeneratedTaskApp(t *testing.T) {
	text := "The printer status panel is ready.\n\n" + taskOutputOpen + " " + validTaskAppJSON(t) + "\n" + taskOutputClose
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.GeneratedApp == nil || result.Text != "The printer status panel is ready." {
		t.Fatalf("Human-facing reply was not preserved with the extracted App: %+v", result)
	}
}

func TestParseHarnessTurnResultAcceptsTaskOutputOnlyForTaskAndRejectsInvalid(t *testing.T) {
	jsonBundle := validTaskAppJSON(t)
	block := taskOutputOpen + "\n" + jsonBundle + "\n" + taskOutputClose
	roomResult := ParseHarnessTurnResult(block, "")
	if roomResult.GeneratedApp != nil || roomResult.Text != block {
		t.Fatalf("Room turn must not accept Task App output: %+v", roomResult)
	}
	invalid := strings.Replace(jsonBundle, `"networkOrigins":[]`, `"networkOrigins":["http://localhost"]`, 1)
	invalidBlock := taskOutputOpen + "\n" + invalid + "\n" + taskOutputClose
	invalidResult := ParseHarnessTurnResult(invalidBlock, "req-printer")
	if invalidResult.GeneratedApp != nil || invalidResult.Text != invalidBlock {
		t.Fatalf("invalid output must remain ordinary text and publish nothing: %+v", invalidResult)
	}
}

func TestParseHarnessTurnResultRejectsNonTerminalGeneratedTaskAppCloseMarker(t *testing.T) {
	text := taskOutputOpen + " " + validTaskAppJSON(t) + "\n" + taskOutputClose + " trailing text"
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.GeneratedApp != nil || result.Text != text {
		t.Fatalf("non-terminal close marker must publish nothing: %+v", result)
	}
}

func TestParseHarnessTurnResultRejectsCombinedRuntimeControls(t *testing.T) {
	jsonBundle := validTaskAppJSON(t)
	text := "Reply\n[[free4chat:targets agent-2]]\n" + taskOutputOpen + "\n" + jsonBundle + "\n" + taskOutputClose
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.GeneratedApp != nil || len(result.TargetParticipantIDs) != 0 || result.Text != text {
		t.Fatalf("Task output must not combine with target control: %+v", result)
	}
	leave := ParseHarnessTurnResult(taskOutputOpen+"\n"+jsonBundle+"\n"+taskOutputClose+"\n[[free4chat:lifecycle leave]]", "req-printer")
	if leave.GeneratedApp != nil || leave.LifecycleIntent != types.LifecycleIntentNone {
		t.Fatalf("Task output must not combine with lifecycle control: %+v", leave)
	}
}
