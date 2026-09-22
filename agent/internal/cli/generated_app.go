package cli

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var generatedAppTitlePattern = regexp.MustCompile(`^[^<>\x00-\x1f\x7f]+$`)

// validateGeneratedAppBundle is the Runtime-side UX preflight. The Room
// repeats every check and remains the canonical security/capacity boundary.
func validateGeneratedAppBundle(data []byte, bundle map[string]any) error {
	if len(data) == 0 || len(data) > maxGeneratedAppBytes {
		return fmt.Errorf("generated App bundle exceeds %d UTF-8 bytes", maxGeneratedAppBytes)
	}
	if !exactGeneratedKeys(bundle, "version", "manifest", "html", "css", "js", "initialState") || bundle["version"] != float64(1) {
		return fmt.Errorf("generated App bundle must use version 1 and the fixed fields")
	}
	manifest, ok := bundle["manifest"].(map[string]any)
	if !ok || !exactGeneratedKeys(manifest, "title", "networkOrigins") {
		return fmt.Errorf("generated App manifest must contain title and networkOrigins")
	}
	title, ok := manifest["title"].(string)
	if !ok || title == "" || len(title) > 80 || !generatedAppTitlePattern.MatchString(title) {
		return fmt.Errorf("generated App title is invalid")
	}
	origins, ok := manifest["networkOrigins"].([]any)
	if !ok || len(origins) != 0 {
		return fmt.Errorf("generated App networkOrigins must be an empty array in V0")
	}
	for _, field := range []string{"html", "css", "js"} {
		source, ok := bundle[field].(string)
		if !ok || source == "" || strings.ContainsRune(source, '\x00') || strings.Contains(strings.ToLower(source), "</script") {
			return fmt.Errorf("generated App %s is invalid", field)
		}
	}
	initialState, ok := bundle["initialState"].(map[string]any)
	if !ok || len(initialState) == 0 && initialState == nil {
		return fmt.Errorf("generated App initialState must be an object")
	}
	stateBytes, err := json.Marshal(initialState)
	if err != nil || len(stateBytes) > 16*1024 {
		return fmt.Errorf("generated App initialState exceeds 16 KiB")
	}
	return nil
}

func exactGeneratedKeys(value map[string]any, keys ...string) bool {
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
