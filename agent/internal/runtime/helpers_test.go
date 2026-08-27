package runtime

import (
	"encoding/json"
)

// mustJSON marshals a value for assertion helpers; test-only.
func mustJSON(t interface {
	Helper()
	Fatalf(string, ...any)
}, value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	return string(data)
}
