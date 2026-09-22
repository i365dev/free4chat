package cli

import (
	"encoding/json"
	"strings"
	"testing"
)

func testGeneratedBundle() map[string]any {
	return map[string]any{
		"version": 1.0,
		"manifest": map[string]any{
			"title":          "Decision matrix",
			"networkOrigins": []any{},
		},
		"html":         "<main>Decision matrix</main>",
		"css":          "main { font: 16px sans-serif; }",
		"js":           "document.body.dataset.ready = 'true'",
		"initialState": map[string]any{"choice": nil},
	}
}

func encodeGeneratedBundle(t *testing.T, bundle map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestValidateGeneratedAppBundle(t *testing.T) {
	bundle := testGeneratedBundle()
	if err := validateGeneratedAppBundle(encodeGeneratedBundle(t, bundle), bundle); err != nil {
		t.Fatalf("valid bundle rejected: %v", err)
	}

	bundle["extra"] = true
	if err := validateGeneratedAppBundle(encodeGeneratedBundle(t, bundle), bundle); err == nil {
		t.Fatal("bundle with extension field was accepted")
	}

	bundle = testGeneratedBundle()
	bundle["js"] = "</script><script>alert(1)"
	if err := validateGeneratedAppBundle(encodeGeneratedBundle(t, bundle), bundle); err == nil {
		t.Fatal("script terminator was accepted")
	}
}

func TestValidateGeneratedAppBundleBoundsAndNetworkDeferral(t *testing.T) {
	bundle := testGeneratedBundle()
	bundle["manifest"].(map[string]any)["networkOrigins"] = []any{"https://example.com"}
	if err := validateGeneratedAppBundle(encodeGeneratedBundle(t, bundle), bundle); err == nil {
		t.Fatal("network-enabled V0 bundle was accepted")
	}

	bundle = testGeneratedBundle()
	bundle["js"] = strings.Repeat("x", maxGeneratedAppBytes)
	if err := validateGeneratedAppBundle(encodeGeneratedBundle(t, bundle), bundle); err == nil {
		t.Fatal("oversized bundle was accepted")
	}
}
