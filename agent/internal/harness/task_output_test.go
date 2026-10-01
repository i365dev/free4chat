package harness

import (
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

func validTaskAppHTML() string {
	return `<!doctype html>
<html>
<head>
  <title>Printer</title>
  <style>main { font: 16px sans-serif; }</style>
</head>
<body>
  <main id="status">Loading</main>
  <script>document.querySelector('#status').textContent = 'Ready';</script>
</body>
</html>`
}

func TestParseHarnessTurnResultNormalizesGeneratedTaskAppHTML(t *testing.T) {
	html := validTaskAppHTML()
	text := "Printer status app is ready.\n" + taskOutputOpen + "\n" + html + "\n" + taskOutputClose
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.Text != "Printer status app is ready." || result.GeneratedApp == nil {
		t.Fatalf("Task App result was not separated from the public reply: %+v", result)
	}
	bundle := result.GeneratedApp.Bundle
	if bundle["version"] != float64(1) || !strings.Contains(bundle["html"].(string), `<main id="status">Loading</main>`) || bundle["js"] != "document.querySelector('#status').textContent = 'Ready';" {
		t.Fatalf("HTML did not normalize to the internal V1 bundle: %#v", bundle)
	}
	manifest, ok := bundle["manifest"].(map[string]any)
	if !ok || manifest["title"] != "Printer" || len(manifest["networkOrigins"].([]any)) != 0 {
		t.Fatalf("normalized manifest is incorrect: %#v", bundle["manifest"])
	}
	if state, ok := bundle["initialState"].(map[string]any); !ok || len(state) != 0 {
		t.Fatalf("V1 initial state must be empty: %#v", bundle["initialState"])
	}
}

func TestParseHarnessTurnResultHTMLDoesNotRequireJSONEscaping(t *testing.T) {
	html := `<!doctype html>
<html><head><title>Quotes and paths</title></head><body>
<pre id="source">quotes: " and path: C:\\printers</pre>
<script>
const message = "a quoted value and C:\\printers";
document.querySelector("#source").textContent += "\n" + message;
</script>
</body></html>`
	result := ParseHarnessTurnResult(taskOutputOpen+"\n"+html+"\n"+taskOutputClose, "req-source")
	if result.GeneratedApp == nil {
		t.Fatalf("ordinary HTML source with quotes, backslashes, and newlines was rejected: %q", result.Text)
	}
	if got := result.GeneratedApp.Bundle["js"].(string); !strings.Contains(got, `"a quoted value`) || !strings.Contains(got, `C:\\printers`) || !strings.Contains(got, "\n") {
		t.Fatalf("JavaScript source did not survive HTML normalization: %q", got)
	}
}

func TestParseHarnessTurnResultAcceptsInlineOpeningMarkerAndHumanReply(t *testing.T) {
	text := "The printer status panel is ready.\n\n" + taskOutputOpen + " " + validTaskAppHTML() + "\n" + taskOutputClose
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.GeneratedApp == nil || result.Text != "The printer status panel is ready." {
		t.Fatalf("inline opening marker or Human-facing reply was not preserved: %+v", result)
	}
}

func TestParseHarnessTurnResultAcceptsTaskOutputOnlyForTaskAndRejectsInvalid(t *testing.T) {
	block := taskOutputOpen + "\n" + validTaskAppHTML() + "\n" + taskOutputClose
	roomResult := ParseHarnessTurnResult(block, "")
	if roomResult.GeneratedApp != nil || roomResult.Text != block {
		t.Fatalf("Room turn must not accept Task App output: %+v", roomResult)
	}
	invalidBlock := taskOutputOpen + "\n" + strings.Replace(validTaskAppHTML(), "<main id=", "<iframe><main id=", 1) + "\n" + taskOutputClose
	invalidResult := ParseHarnessTurnResult(invalidBlock, "req-printer")
	if invalidResult.GeneratedApp != nil || invalidResult.Text != invalidBlock {
		t.Fatalf("invalid output must remain ordinary text and publish nothing: %+v", invalidResult)
	}
}

func TestParseHarnessTurnResultRejectsNonTerminalGeneratedTaskAppCloseMarker(t *testing.T) {
	text := taskOutputOpen + " " + validTaskAppHTML() + "\n" + taskOutputClose + " trailing text"
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.GeneratedApp != nil || result.Text != text {
		t.Fatalf("non-terminal close marker must publish nothing: %+v", result)
	}
}

func TestParseHarnessTurnResultRejectsCombinedRuntimeControls(t *testing.T) {
	text := "Reply\n[[free4chat:targets agent-2]]\n" + taskOutputOpen + "\n" + validTaskAppHTML() + "\n" + taskOutputClose
	result := ParseHarnessTurnResult(text, "req-printer")
	if result.GeneratedApp != nil || len(result.TargetParticipantIDs) != 0 || result.Text != text {
		t.Fatalf("Task output must not combine with target control: %+v", result)
	}
	leave := ParseHarnessTurnResult(taskOutputOpen+"\n"+validTaskAppHTML()+"\n"+taskOutputClose+"\n[[free4chat:lifecycle leave]]", "req-printer")
	if leave.GeneratedApp != nil || leave.LifecycleIntent != types.LifecycleIntentNone {
		t.Fatalf("Task output must not combine with lifecycle control: %+v", leave)
	}
}
