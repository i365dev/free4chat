package cli

import (
	"encoding/json"
	"strings"
	"testing"
)

func validLiveViewDraft() map[string]any {
	return map[string]any{
		"surfaceId": "counter",
		"revision":  1,
		"root": map[string]any{
			"type": "Card",
			"children": []any{
				map[string]any{"type": "Value", "path": "count"},
				map[string]any{
					"type": "Button", "label": "+1",
					"action": map[string]any{"type": "increment", "path": "count", "amount": 1},
				},
			},
		},
		"data": map[string]any{"count": 0},
	}
}

func TestValidateTaskLiveViewJSON(t *testing.T) {
	valid, err := json.Marshal(validLiveViewDraft())
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTaskLiveViewJSON(valid); err != nil {
		t.Fatalf("valid draft rejected: %v", err)
	}

	cases := []struct {
		name string
		edit func(map[string]any)
		want string
	}{
		{"unknown component", func(surface map[string]any) {
			surface["root"] = map[string]any{"type": "Html", "html": "<b>x</b>"}
		}, "unknown component"},
		{"unknown action", func(surface map[string]any) {
			surface["root"].(map[string]any)["children"].([]any)[1].(map[string]any)["action"] = map[string]any{"type": "decrement", "path": "count", "amount": 1}
		}, "action type"},
		{"input number", func(surface map[string]any) {
			surface["root"] = map[string]any{"type": "Input", "path": "count"}
		}, "Input path"},
		{"increment text", func(surface map[string]any) {
			surface["data"] = map[string]any{"count": "0"}
		}, "increment path"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			surface := validLiveViewDraft()
			testCase.edit(surface)
			data, err := json.Marshal(surface)
			if err != nil {
				t.Fatal(err)
			}
			err = validateTaskLiveViewJSON(data)
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error %q does not contain %q", err, testCase.want)
			}
		})
	}
}
