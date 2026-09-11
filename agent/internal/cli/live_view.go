package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const (
	maxLiveViewComponents = 64
	maxLiveViewDepth      = 8
	maxLiveViewDataKeys   = 32
	maxLiveViewText       = 400
	maxLiveViewLabel      = 80
)

var (
	liveViewIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
	liveViewDataPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
)

// validateTaskLiveViewJSON is a local, deterministic preflight. The Room is
// still authoritative; this only turns common authoring mistakes into useful
// CLI errors before an IPC/MCP round trip.
func validateTaskLiveViewJSON(data []byte) error {
	if len(data) > maxTaskLiveViewBytes {
		return fmt.Errorf("Live View JSON exceeds %d UTF-8 bytes", maxTaskLiveViewBytes)
	}
	var raw any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(&raw); err != nil {
		return fmt.Errorf("Live View JSON must be valid JSON: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	object, ok := raw.(map[string]any)
	if !ok || len(object) == 0 {
		return fmt.Errorf("Live View JSON must be a non-empty object")
	}
	allowed := map[string]bool{
		"surfaceId": true, "revision": true, "root": true, "data": true,
		// Older callers may still provide a canonical snapshot. The Room
		// replaces these fields with authenticated values.
		"taskRequestId": true, "authorityAgentId": true,
	}
	for key := range object {
		if !allowed[key] {
			return fmt.Errorf("Live View JSON has unknown field %q", key)
		}
	}
	if value, ok := object["surfaceId"].(string); !ok || !liveViewIDPattern.MatchString(value) {
		return fmt.Errorf("Live View surfaceId must be a non-empty safe identifier")
	}
	if revision, ok := object["revision"].(float64); !ok || revision < 1 || revision != float64(int64(revision)) {
		return fmt.Errorf("Live View revision must be a positive integer")
	}
	for _, key := range []string{"taskRequestId", "authorityAgentId"} {
		if value, present := object[key]; present {
			if text, ok := value.(string); !ok || !liveViewIDPattern.MatchString(text) {
				return fmt.Errorf("Live View %s must be a safe identifier", key)
			}
		}
	}
	dataObject, ok := object["data"].(map[string]any)
	if !ok || len(dataObject) > maxLiveViewDataKeys {
		return fmt.Errorf("Live View data must be an object with at most %d keys", maxLiveViewDataKeys)
	}
	for key, value := range dataObject {
		if !liveViewDataPattern.MatchString(key) || !validLiveViewScalar(value) {
			return fmt.Errorf("Live View data key %q must contain a bounded string, number, or boolean", key)
		}
	}
	count := 0
	if err := validateLiveViewComponent(object["root"], 1, &count, dataObject); err != nil {
		return err
	}
	return nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return fmt.Errorf("Live View JSON must contain one object")
	} else if err != io.EOF {
		return fmt.Errorf("Live View JSON must contain one object: %w", err)
	}
	return nil
}

func validLiveViewScalar(value any) bool {
	switch typed := value.(type) {
	case bool:
		return true
	case float64:
		return true
	case string:
		return javascriptStringLength(typed) > 0 && javascriptStringLength(typed) <= maxLiveViewText && !strings.ContainsAny(typed, "<>") &&
			!strings.Contains(strings.ToLower(typed), "javascript:") &&
			!strings.Contains(strings.ToLower(typed), "http://") &&
			!strings.Contains(strings.ToLower(typed), "https://") &&
			!strings.Contains(strings.ToLower(typed), "data:")
	default:
		return false
	}
}

func validateLiveViewComponent(value any, depth int, count *int, data map[string]any) error {
	if depth > maxLiveViewDepth {
		return fmt.Errorf("Live View component nesting exceeds %d levels", maxLiveViewDepth)
	}
	component, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("Live View component must be an object")
	}
	*count = *count + 1
	if *count > maxLiveViewComponents {
		return fmt.Errorf("Live View contains more than %d components", maxLiveViewComponents)
	}
	typeName, ok := component["type"].(string)
	if !ok {
		return fmt.Errorf("Live View component type is required")
	}
	allowed := map[string]bool{"Text": true, "Value": true, "Button": true, "Input": true, "Row": true, "Column": true, "Card": true}
	if !allowed[typeName] {
		return fmt.Errorf("Live View contains unknown component %q", typeName)
	}
	switch typeName {
	case "Text":
		if err := liveViewOnlyKeys(component, "type", "text"); err != nil {
			return err
		}
		if text, ok := component["text"].(string); !ok || !safeLiveViewText(text, maxLiveViewText) {
			return fmt.Errorf("Live View Text requires bounded safe text")
		}
	case "Value":
		if err := liveViewOnlyKeys(component, "type", "path"); err != nil {
			return err
		}
		if _, err := liveViewPath(component, "Value"); err != nil {
			return err
		}
	case "Input":
		if err := liveViewOnlyKeys(component, "type", "path", "placeholder"); err != nil {
			return err
		}
		path, err := liveViewPath(component, "Input")
		if err != nil {
			return err
		}
		if text, ok := data[path].(string); !ok || !safeLiveViewText(text, maxLiveViewText) {
			return fmt.Errorf("Live View Input path %q must reference a declared string data key", path)
		}
		if placeholder, present := component["placeholder"]; present {
			text, ok := placeholder.(string)
			if !ok || !safeLiveViewText(text, maxLiveViewLabel) {
				return fmt.Errorf("Live View Input placeholder must be bounded safe text")
			}
		}
	case "Button":
		if err := liveViewOnlyKeys(component, "type", "label", "action"); err != nil {
			return err
		}
		label, ok := component["label"].(string)
		if !ok || !safeLiveViewText(label, maxLiveViewLabel) {
			return fmt.Errorf("Live View Button requires a bounded label")
		}
		action, ok := component["action"].(map[string]any)
		if !ok {
			return fmt.Errorf("Live View Button requires an action")
		}
		actionType, ok := action["type"].(string)
		if !ok || (actionType != "increment" && actionType != "set") {
			return fmt.Errorf("Live View action type %q is unsupported", actionType)
		}
		path, err := liveViewPath(action, "Button action")
		if err != nil {
			return err
		}
		switch actionType {
		case "increment":
			if err := liveViewOnlyKeys(action, "type", "path", "amount"); err != nil {
				return err
			}
			amount, ok := action["amount"].(float64)
			if !ok || amount == 0 || amount != float64(int64(amount)) || amount < -1000 || amount > 1000 {
				return fmt.Errorf("Live View increment amount must be a non-zero integer between -1000 and 1000")
			}
			if _, ok := data[path].(float64); !ok {
				return fmt.Errorf("Live View increment path %q must reference a number data key", path)
			}
		case "set":
			if err := liveViewOnlyKeys(action, "type", "path", "value"); err != nil {
				return err
			}
			if !validLiveViewScalar(action["value"]) {
				return fmt.Errorf("Live View set value must be a string, number, or boolean")
			}
		}
	case "Row", "Column", "Card":
		if err := liveViewOnlyKeys(component, "type", "children"); err != nil {
			return err
		}
		children, ok := component["children"].([]any)
		if !ok || len(children) == 0 || len(children) > maxLiveViewComponents {
			return fmt.Errorf("Live View %s requires bounded children", typeName)
		}
		for _, child := range children {
			if err := validateLiveViewComponent(child, depth+1, count, data); err != nil {
				return err
			}
		}
	}
	return nil
}

func liveViewOnlyKeys(value map[string]any, keys ...string) error {
	allowed := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		allowed[key] = struct{}{}
	}
	for key := range value {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("Live View has unexpected field %q", key)
		}
	}
	return nil
}

func liveViewPath(value map[string]any, label string) (string, error) {
	path, ok := value["path"].(string)
	if !ok || !liveViewDataPattern.MatchString(path) {
		return "", fmt.Errorf("Live View %s path must be a safe data key", label)
	}
	return path, nil
}

func safeLiveViewText(value string, max int) bool {
	lower := strings.ToLower(value)
	return javascriptStringLength(value) > 0 && javascriptStringLength(value) <= max && !strings.ContainsAny(value, "<>") &&
		!strings.Contains(lower, "javascript:") &&
		!strings.Contains(lower, "http://") &&
		!strings.Contains(lower, "https://") &&
		!strings.Contains(lower, "data:")
}

// javascriptStringLength matches JS String.length, which counts UTF-16 code
// units rather than UTF-8 bytes or Unicode scalar values. The Room validator
// is authoritative and uses the same semantics for bounded text fields.
func javascriptStringLength(value string) int {
	length := 0
	for _, r := range value {
		if r > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}
