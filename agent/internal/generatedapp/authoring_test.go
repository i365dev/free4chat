package generatedapp

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeHTMLPrinterDocument(t *testing.T) {
	source := `<!doctype html>
<html>
<head>
  <title>Printer</title>
  <style>body { font: 16px sans-serif; }</style>
</head>
<body>
  <h1>Printer</h1>
  <p>Status: <span id="status">Loading</span></p>
  <button id="refresh">Refresh</button>
  <script>document.querySelector("#status").textContent = "Ready";</script>
</body>
</html>`
	bundle, err := NormalizeHTML(source)
	if err != nil {
		t.Fatalf("NormalizeHTML() error = %v", err)
	}
	if bundle["version"] != float64(1) || !strings.Contains(bundle["html"].(string), `<h1>Printer</h1>`) || !strings.Contains(bundle["html"].(string), `<button id="refresh">Refresh</button>`) {
		t.Fatalf("normalized internal bundle fields are wrong: %#v", bundle)
	}
	manifest := bundle["manifest"].(map[string]any)
	if manifest["title"] != "Printer" || len(manifest["networkOrigins"].([]any)) != 0 {
		t.Fatalf("manifest was not derived from HTML: %#v", manifest)
	}
	if bundle["css"] != "body { font: 16px sans-serif; }" || bundle["js"] != `document.querySelector("#status").textContent = "Ready";` {
		t.Fatalf("style or script was not normalized: css=%q js=%q", bundle["css"], bundle["js"])
	}
	if state := bundle["initialState"].(map[string]any); len(state) != 0 {
		t.Fatalf("V1 initialState should be empty: %#v", state)
	}
}

func TestNormalizeHTMLPreservesQuotesBackslashesAndNewlines(t *testing.T) {
	source := `<!doctype html>
<html><head><title>Source</title></head><body>
<pre data-value="say &quot;hello&quot;">quotes " and path C:\printers</pre>
<script>
const message = "say \"hello\"";
const path = "C:\\printers";
</script>
</body></html>`
	bundle, err := NormalizeHTML(source)
	if err != nil {
		t.Fatalf("ordinary HTML source should not require Agent JSON escaping: %v", err)
	}
	if got := bundle["html"].(string); !strings.Contains(got, `data-value="say &#34;hello&#34;"`) || !strings.Contains(got, `quotes &#34; and path C:\printers`) {
		t.Fatalf("HTML source did not survive parser serialization: %q", got)
	}
	if got := bundle["js"].(string); !strings.Contains(got, `say \"hello\"`) || !strings.Contains(got, `C:\\printers`) || !strings.Contains(got, "\n") {
		t.Fatalf("JavaScript source did not survive parser extraction: %q", got)
	}
}

func TestNormalizeHTMLExtractsDecodedTitle(t *testing.T) {
	bundle, err := NormalizeHTML(`<html><head><title>Printer &amp; Queue</title></head><body><p>Status</p></body></html>`)
	if err != nil {
		t.Fatalf("NormalizeHTML() error = %v", err)
	}
	if got := bundle["manifest"].(map[string]any)["title"]; got != "Printer & Queue" {
		t.Fatalf("title = %#v, want decoded text", got)
	}
}

func TestNormalizeHTMLConcatenatesStylesInSourceOrder(t *testing.T) {
	source := `<html><head><title>Styles</title><style>.first { color: red; }</style><style>.second { color: blue; }</style></head><body><p>Content</p></body></html>`
	bundle, err := NormalizeHTML(source)
	if err != nil {
		t.Fatalf("NormalizeHTML() error = %v", err)
	}
	if got, want := bundle["css"], ".first { color: red; }\n.second { color: blue; }"; got != want {
		t.Fatalf("css = %q, want %q", got, want)
	}
}

func TestNormalizeHTMLAllowsOneFinalClassicScriptAndScriptlessApp(t *testing.T) {
	bundle, err := NormalizeHTML(`<html><head><title>Final script</title></head><body><p>Ready</p><script>window.ready = true;</script><!-- trailing comment -->
</body></html>`)
	if err != nil {
		t.Fatalf("final classic script should normalize: %v", err)
	}
	if bundle["js"] != "window.ready = true;" || !strings.Contains(bundle["html"].(string), `<p>Ready</p>`) || !strings.Contains(bundle["html"].(string), `<!-- trailing comment -->`) {
		t.Fatalf("script/body normalization is wrong: %#v", bundle)
	}

	scriptless, err := NormalizeHTML(`<html><head><title>Static</title></head><body><p>No script needed</p></body></html>`)
	if err != nil {
		t.Fatalf("scriptless App should normalize using internal minimum source: %v", err)
	}
	if scriptless["js"] != "/* no app script */" || scriptless["css"] != "/* no app styles */" {
		t.Fatalf("scriptless placeholders are incorrect: %#v", scriptless)
	}
}

func TestNormalizeHTMLRejectsMultipleScripts(t *testing.T) {
	source := `<html><head><title>Bad</title></head><body><p>App</p><script>one()</script><script>two()</script></body></html>`
	if _, err := NormalizeHTML(source); err == nil {
		t.Fatal("multiple executable scripts must be rejected")
	}
}

func TestNormalizeHTMLRejectsHeadAndNonFinalScripts(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "head script", src: `<html><head><title>Bad</title><script>run()</script></head><body><p>App</p></body></html>`},
		{name: "script not final", src: `<html><head><title>Bad</title></head><body><script>run()</script><p>App</p></body></html>`},
		{name: "meaningful text after script", src: `<html><head><title>Bad</title></head><body><p>App</p><script>run()</script>tail</body></html>`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NormalizeHTML(test.src); err == nil {
				t.Fatal("unsupported script placement must be rejected")
			}
		})
	}
}

func TestNormalizeHTMLRejectsExternalModulesAndDeferredScripts(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "external script", src: `<html><head><title>Bad</title></head><body><p>App</p><script src="https://example.com/app.js"></script></body></html>`},
		{name: "module", src: `<html><head><title>Bad</title></head><body><p>App</p><script type="module">run()</script></body></html>`},
		{name: "async", src: `<html><head><title>Bad</title></head><body><p>App</p><script async>run()</script></body></html>`},
		{name: "defer", src: `<html><head><title>Bad</title></head><body><p>App</p><script defer>run()</script></body></html>`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NormalizeHTML(test.src); err == nil {
				t.Fatal("unsupported script type/source must be rejected")
			}
		})
	}
}

func TestNormalizeHTMLRejectsMissingOrEmptyTitleAndIncompleteDocument(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "missing title", src: `<html><head></head><body><p>App</p></body></html>`},
		{name: "empty title", src: `<html><head><title>   </title></head><body><p>App</p></body></html>`},
		{name: "missing head", src: `<html><title>Bad</title><body><p>App</p></body></html>`},
		{name: "missing body", src: `<html><head><title>Bad</title></head></html>`},
		{name: "duplicate title", src: `<html><head><title>One</title><title>Two</title></head><body><p>App</p></body></html>`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NormalizeHTML(test.src); err == nil {
				t.Fatal("incomplete or ambiguous document must be rejected")
			}
		})
	}
}

func TestNormalizeHTMLRejectsExternalResources(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "stylesheet link", src: `<html><head><title>Bad</title><link rel="stylesheet" href="https://example.com/app.css"></head><body><p>App</p></body></html>`},
		{name: "image resource", src: `<html><head><title>Bad</title></head><body><img src="https://example.com/image.png"></body></html>`},
		{name: "external anchor", src: `<html><head><title>Bad</title></head><body><a href="https://example.com">Open</a></body></html>`},
		{name: "base URL", src: `<html><head><title>Bad</title><base href="https://example.com/"></head><body><p>App</p></body></html>`},
		{name: "form action", src: `<html><head><title>Bad</title></head><body><form action="https://example.com"><button>Send</button></form></body></html>`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NormalizeHTML(test.src); err == nil {
				t.Fatal("external resources/dependencies must be rejected")
			}
		})
	}
}

func TestNormalizeHTMLRejectsOversizeBeforeAndAfterNormalization(t *testing.T) {
	base := `<html><head><title>Large</title></head><body><p>`
	end := `</p></body></html>`
	overRaw := base + strings.Repeat("x", maxAuthoringHTMLBytes) + end
	if _, err := NormalizeHTML(overRaw); err == nil {
		t.Fatal("raw HTML over 48 KiB must be rejected before parsing")
	}

	// Each quote is valid HTML script text but expands to two bytes when the
	// internal bundle is JSON-serialized. The raw source fits the authoring
	// bound while its normalized V1 bundle exceeds the existing total bound.
	quotes := strings.Repeat(`"`, MaxBundleBytes/2+1)
	overBundle := `<html><head><title>Large</title></head><body><p>App</p><script>` + quotes + `</script></body></html>`
	if len(overBundle) > maxAuthoringHTMLBytes {
		t.Fatalf("test source unexpectedly exceeds the raw bound: %d", len(overBundle))
	}
	if _, err := NormalizeHTML(overBundle); err == nil {
		t.Fatal("normalized JSON bundle over 48 KiB must be rejected")
	}

	overField := `<html><head><title>Large</title></head><body><p>` + strings.Repeat("x", MaxHTMLBytes+1) + `</p></body></html>`
	if _, err := NormalizeHTML(overField); err == nil {
		t.Fatal("normalized HTML field over 20 KiB must be rejected")
	}
}

func TestNormalizeHTMLRetainsExistingSafeSourceChecks(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "NUL", src: `<html><head><title>Bad</title></head><body><p>` + string(rune(0)) + `</p></body></html>`},
		{name: "iframe", src: `<html><head><title>Bad</title></head><body><iframe></iframe><p>App</p></body></html>`},
		{name: "object", src: `<html><head><title>Bad</title></head><body><object></object><p>App</p></body></html>`},
		{name: "embed", src: `<html><head><title>Bad</title></head><body><embed><p>App</p></body></html>`},
		{name: "javascript scheme", src: `<html><head><title>Bad</title></head><body><p>App</p><script>const scheme = "javascript:";</script></body></html>`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NormalizeHTML(test.src); err == nil {
				t.Fatal("existing safeSource constraint must reject normalized source")
			}
		})
	}
}

func TestNormalizeHTMLInternalBundleRemainsCanonicalV1(t *testing.T) {
	bundle, err := NormalizeHTML(`<html><head><title>Internal</title></head><body><p>Stable</p></body></html>`)
	if err != nil {
		t.Fatalf("NormalizeHTML() error = %v", err)
	}
	if !exactKeys(bundle, "version", "manifest", "html", "css", "js", "initialState") {
		t.Fatalf("normalized output changed the internal V1 key set: %#v", bundle)
	}
	encoded, err := json.Marshal(bundle)
	if err != nil || Validate(encoded, bundle) != nil {
		t.Fatalf("normalized bundle does not pass canonical V1 validation: %v", err)
	}
}
