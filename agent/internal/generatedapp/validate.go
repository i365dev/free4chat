package generatedapp

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const (
	MaxBundleBytes = 48 * 1024
	MaxHTMLBytes   = 20 * 1024
	MaxCSSBytes    = 12 * 1024
	MaxJSBytes     = 32 * 1024
	MaxStateBytes  = 16 * 1024
)

var titlePattern = regexp.MustCompile(`^[^<>\x00-\x1f\x7f]+$`)

// Validate checks the fixed Generated Task App V1 bundle contract. The Room
// repeats these checks and remains the canonical publication boundary.
func Validate(data []byte, bundle map[string]any) error {
	if len(data) == 0 || len(data) > MaxBundleBytes {
		return fmt.Errorf("generated App bundle exceeds %d UTF-8 bytes", MaxBundleBytes)
	}
	if !exactKeys(bundle, "version", "manifest", "html", "css", "js", "initialState") || bundle["version"] != float64(1) {
		return fmt.Errorf("generated App bundle must use version 1 and the fixed fields")
	}
	manifest, ok := bundle["manifest"].(map[string]any)
	if !ok || !exactKeys(manifest, "title", "networkOrigins") {
		return fmt.Errorf("generated App manifest must contain title and networkOrigins")
	}
	title, ok := manifest["title"].(string)
	if !ok || title == "" || len(title) > 80 || !titlePattern.MatchString(title) {
		return fmt.Errorf("generated App title is invalid")
	}
	origins, ok := manifest["networkOrigins"].([]any)
	if !ok || len(origins) != 0 {
		return fmt.Errorf("generated App networkOrigins must be an empty array in V0")
	}
	for _, field := range []struct {
		name string
		max  int
	}{
		{name: "html", max: MaxHTMLBytes},
		{name: "css", max: MaxCSSBytes},
		{name: "js", max: MaxJSBytes},
	} {
		source, ok := bundle[field.name].(string)
		if !ok || len(source) == 0 || len(source) > field.max || !safeSource(source) {
			return fmt.Errorf("generated App %s is invalid", field.name)
		}
	}
	initialState, ok := bundle["initialState"].(map[string]any)
	if !ok || len(initialState) == 0 && initialState == nil {
		return fmt.Errorf("generated App initialState must be an object")
	}
	stateBytes, err := json.Marshal(initialState)
	if err != nil || len(stateBytes) > MaxStateBytes {
		return fmt.Errorf("generated App initialState exceeds 16 KiB")
	}
	return nil
}

func safeSource(source string) bool {
	lower := strings.ToLower(source)
	return !strings.ContainsRune(source, '\x00') &&
		!strings.Contains(lower, "</script") &&
		!strings.Contains(lower, "<iframe") &&
		!strings.Contains(lower, "<object") &&
		!strings.Contains(lower, "<embed") &&
		!strings.Contains(lower, "javascript:")
}

func exactKeys(value map[string]any, keys ...string) bool {
	if len(value) != len(keys) {
		return false
	}
	allowed := make(map[string]bool, len(keys))
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range value {
		if !allowed[key] {
			return false
		}
	}
	return true
}
