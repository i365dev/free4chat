package harness

import (
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
