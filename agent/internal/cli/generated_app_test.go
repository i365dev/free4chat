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

func TestGeneratedAppDescribeIsDeterministicAndSelfConsistent(t *testing.T) {
	first, err := json.Marshal(describeGeneratedApp())
	if err != nil {
		t.Fatal(err)
	}
	second, err := json.Marshal(describeGeneratedApp())
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("generated-app describe output is not deterministic")
	}
	descriptor := describeGeneratedApp()
	if descriptor.Contract != "free4chat.generated-task-app" || descriptor.ContractVersion != 1 {
		t.Fatalf("unexpected contract: %#v", descriptor)
	}
	if descriptor.Limits.MaxBundleBytes != maxGeneratedAppBytes ||
		descriptor.Limits.MaxStateBytes != generatedAppStateBytes ||
		descriptor.Bundle.Version != 1 || len(descriptor.Bundle.NetworkOrigins) != 0 {
		t.Fatalf("descriptor drifted from validator constants: %#v", descriptor)
	}
	if len(descriptor.Examples) != 1 {
		t.Fatalf("expected one minimal example, got %d", len(descriptor.Examples))
	}
	if err := validateGeneratedAppBundle(
		encodeGeneratedBundle(t, descriptor.Examples[0].Bundle),
		descriptor.Examples[0].Bundle,
	); err != nil {
		t.Fatalf("describe example is not accepted by the validator: %v", err)
	}
	if js, _ := descriptor.Examples[0].Bundle["js"].(string); !strings.Contains(js, "items:[...items") || !strings.Contains(js, "shared.set") {
		t.Fatalf("describe example must demonstrate a real shared checklist update: %s", js)
	}
}

func TestGeneratedAppDescribeCommandRoutesAndEmitsJSON(t *testing.T) {
	output, code := runCli(t, "generated-app", "describe", "--json")
	if code != 0 {
		t.Fatalf("generated-app describe --json exited %d: %s", code, output)
	}
	var descriptor generatedAppDescriptor
	if err := json.Unmarshal([]byte(output), &descriptor); err != nil {
		t.Fatalf("describe output was not JSON: %v", err)
	}
	if descriptor.Contract != "free4chat.generated-task-app" {
		t.Fatalf("unexpected CLI contract: %#v", descriptor)
	}
	if _, code := runCli(t, "generated-app", "describe", "--yaml"); code != 2 {
		t.Fatalf("unsupported describe format should exit 2, got %d", code)
	}
}
