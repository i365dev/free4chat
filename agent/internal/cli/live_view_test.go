package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
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

func TestValidateTaskLiveViewJSONUsesJavaScriptUTF16Length(t *testing.T) {
	for _, value := range []string{
		strings.Repeat("界", 200),
		strings.Repeat("😀", 200),
	} {
		surface := validLiveViewDraft()
		surface["data"] = map[string]any{"count": 0, "label": value}
		data, err := json.Marshal(surface)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateTaskLiveViewJSON(data); err != nil {
			t.Fatalf("server-compatible UTF-16 text rejected: %v", err)
		}
	}
}

// liveViewDraftWithRoot builds a draft around one root component and the two
// data keys the contract tests bind to.
func liveViewDraftWithRoot(root map[string]any) map[string]any {
	return map[string]any{
		"surfaceId": "contract",
		"revision":  1,
		"root":      root,
		"data":      map[string]any{"count": 1, "label": "ok"},
	}
}

// minimalLiveViewComponent returns the smallest valid component of one
// canonical type. It is built from the descriptor's own field lists so the
// drift tests below exercise exactly what the contract advertises.
func minimalLiveViewComponent(t *testing.T, typeName string) map[string]any {
	t.Helper()
	component := map[string]any{"type": typeName}
	for _, field := range liveViewComponentRequiredFields[typeName] {
		switch field {
		case "type":
		case "text":
			component["text"] = "ok"
		case "path":
			// Input binds to a declared string key; Value reads a number key.
			component["path"] = "count"
			if typeName == "Input" {
				component["path"] = "label"
			}
		case "label":
			component["label"] = "ok"
		case "action":
			component["action"] = map[string]any{"type": "increment", "path": "count", "amount": 1}
		case "children":
			component["children"] = []any{map[string]any{"type": "Text", "text": "ok"}}
		default:
			t.Fatalf("contract field %q has no test fixture", field)
		}
	}
	return component
}

func TestLiveViewDescribeIsDeterministicAndSelfConsistent(t *testing.T) {
	first, err := json.Marshal(describeTaskLiveView())
	if err != nil {
		t.Fatal(err)
	}
	second, err := json.Marshal(describeTaskLiveView())
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("live-view describe output is not deterministic")
	}
	descriptor := describeTaskLiveView()
	if descriptor.Contract != "free4chat.task-live-view" || descriptor.ContractVersion != 1 {
		t.Fatalf("contract identity drifted: %+v", descriptor)
	}
	if len(descriptor.Examples) == 0 || len(descriptor.Examples) > 2 {
		t.Fatalf("expected one or two minimal examples, got %d", len(descriptor.Examples))
	}
	for index, example := range descriptor.Examples {
		data, err := json.Marshal(example)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateTaskLiveViewJSON(data); err != nil {
			t.Fatalf("example %d is rejected by the authoritative validator: %v", index, err)
		}
	}
	if data, err := json.Marshal(descriptor.Examples[0]); err != nil {
		t.Fatal(err)
	} else if strings.Count(string(data), `"type"`) < 2 {
		t.Fatal("the primary example must be a non-trivial first draft")
	}
}

func TestLiveViewDescribeLimitsMatchTheValidator(t *testing.T) {
	descriptor := describeTaskLiveView()
	limits := descriptor.Limits
	if limits.MaxJSONBytes != maxTaskLiveViewBytes ||
		limits.MaxComponents != maxLiveViewComponents ||
		limits.MaxDepth != maxLiveViewDepth ||
		limits.MaxDataKeys != maxLiveViewDataKeys ||
		limits.MaxTextLength != maxLiveViewText ||
		limits.MaxLabelLength != maxLiveViewLabel ||
		limits.MaxChildrenPerContainer != maxLiveViewComponents ||
		limits.IncrementAmountMin != -liveViewIncrementBound ||
		limits.IncrementAmountMax != liveViewIncrementBound {
		t.Fatalf("descriptor limits drifted from the validator constants: %+v", limits)
	}
	if descriptor.Snapshot.RevisionMin != minLiveViewRevision ||
		descriptor.Snapshot.SurfaceIDPattern != liveViewIDPattern.String() ||
		descriptor.Snapshot.DataKeyPattern != liveViewDataPattern.String() {
		t.Fatalf("descriptor identifier rules drifted: %+v", descriptor.Snapshot)
	}

	// Every advertised component type must have exactly the advertised fields,
	// and the validator must reject anything outside that set.
	if len(descriptor.Components) != len(liveViewComponentTypes) {
		t.Fatalf("component vocabulary drifted: %+v", descriptor.Components)
	}
	advertisedTypes := make(map[string]bool, len(liveViewComponentTypes))
	for _, typeName := range liveViewComponentTypes {
		advertisedTypes[typeName] = true
		if len(liveViewComponentFields[typeName]) == 0 || len(liveViewComponentRequiredFields[typeName]) == 0 {
			t.Fatalf("%s has no canonical field table", typeName)
		}
		for _, required := range liveViewComponentRequiredFields[typeName] {
			allowed := false
			for _, field := range liveViewComponentFields[typeName] {
				if field == required {
					allowed = true
				}
			}
			if !allowed {
				t.Fatalf("%s requires %q but does not allow it", typeName, required)
			}
		}
	}
	for typeName := range liveViewComponentFields {
		if !advertisedTypes[typeName] {
			t.Fatalf("%s has a validator table but is not advertised", typeName)
		}
	}
	for _, component := range descriptor.Components {
		allowed, known := liveViewComponentFields[component.Type]
		if !known {
			t.Fatalf("descriptor advertises an unknown component %q", component.Type)
		}
		advertised := append(append([]string(nil), component.RequiredFields...), component.OptionalFields...)
		if len(advertised) != len(allowed) {
			t.Fatalf("%s advertises %v but the validator allows %v", component.Type, advertised, allowed)
		}
		valid := liveViewDraftWithRoot(minimalLiveViewComponent(t, component.Type))
		if err := marshalAndValidate(t, valid); err != nil {
			t.Fatalf("descriptor's %s shape is rejected by the validator: %v", component.Type, err)
		}
		// A required field that is missing must be rejected.
		for _, field := range component.RequiredFields {
			if field == "type" {
				continue
			}
			broken := liveViewDraftWithRoot(minimalLiveViewComponent(t, component.Type))
			delete(broken["root"].(map[string]any), field)
			if err := marshalAndValidate(t, broken); err == nil {
				t.Fatalf("%s without required field %q was accepted", component.Type, field)
			}
		}
		// A field outside the advertised set must be rejected.
		extra := liveViewDraftWithRoot(minimalLiveViewComponent(t, component.Type))
		extra["root"].(map[string]any)["level"] = 2
		if err := marshalAndValidate(t, extra); err == nil {
			t.Fatalf("%s with an unadvertised field was accepted", component.Type)
		}
	}

	// Every advertised action must be accepted and an unadvertised one must not.
	if len(descriptor.Actions) != len(liveViewActionTypes) {
		t.Fatalf("action vocabulary drifted: %+v", descriptor.Actions)
	}
	advertisedActions := make(map[string]bool, len(liveViewActionTypes))
	for _, actionType := range liveViewActionTypes {
		advertisedActions[actionType] = true
		if !liveViewActionSupported(actionType) {
			t.Fatalf("%s is advertised without a canonical field table", actionType)
		}
	}
	for actionType := range liveViewActionFields {
		if !advertisedActions[actionType] {
			t.Fatalf("%s has a validator table but is not advertised", actionType)
		}
	}
	for _, action := range descriptor.Actions {
		if !liveViewActionSupported(action.Type) {
			t.Fatalf("descriptor advertises an unknown action %q", action.Type)
		}
	}
	unsupported := liveViewDraftWithRoot(map[string]any{
		"type": "Button", "label": "ok",
		"action": map[string]any{"type": "decrement", "path": "count", "amount": 1},
	})
	if err := marshalAndValidate(t, unsupported); err == nil {
		t.Fatal("an unadvertised action type was accepted")
	}
	if err := marshalAndValidate(t, liveViewDraftWithRoot(map[string]any{"type": "Table"})); err == nil {
		t.Fatal("an unadvertised component type was accepted")
	}
}

func TestLiveViewDescribeBoundsAreEnforced(t *testing.T) {
	// Depth: a chain at the advertised depth is accepted; one deeper is not.
	chain := func(depth int) map[string]any {
		component := map[string]any{"type": "Text", "text": "ok"}
		for level := 1; level < depth; level++ {
			component = map[string]any{"type": "Column", "children": []any{component}}
		}
		return component
	}
	if err := marshalAndValidate(t, liveViewDraftWithRoot(chain(maxLiveViewDepth))); err != nil {
		t.Fatalf("component tree at the advertised depth was rejected: %v", err)
	}
	if err := marshalAndValidate(t, liveViewDraftWithRoot(chain(maxLiveViewDepth+1))); err == nil {
		t.Fatal("component tree deeper than the advertised depth was accepted")
	}

	// Components: root + N children must stay within the advertised total.
	children := func(count int) map[string]any {
		list := make([]any, 0, count)
		for index := 0; index < count; index++ {
			list = append(list, map[string]any{"type": "Text", "text": "ok"})
		}
		return map[string]any{"type": "Row", "children": list}
	}
	if err := marshalAndValidate(t, liveViewDraftWithRoot(children(maxLiveViewComponents-1))); err != nil {
		t.Fatalf("component tree at the advertised total was rejected: %v", err)
	}
	if err := marshalAndValidate(t, liveViewDraftWithRoot(children(maxLiveViewComponents))); err == nil {
		t.Fatal("component tree above the advertised total was accepted")
	}

	// Data keys, text, label, revision, and increment bounds.
	fullData := func(keys int) map[string]any {
		data := map[string]any{"count": 0}
		for index := 1; index < keys; index++ {
			data["k"+string(rune('a'+index%26))+strings.Repeat("x", index/26)] = 1
		}
		return data
	}
	atKeys := liveViewDraftWithRoot(minimalLiveViewComponent(t, "Value"))
	atKeys["data"] = fullData(maxLiveViewDataKeys)
	if len(atKeys["data"].(map[string]any)) != maxLiveViewDataKeys {
		t.Fatal("test fixture did not reach the advertised data-key bound")
	}
	if err := marshalAndValidate(t, atKeys); err != nil {
		t.Fatalf("data at the advertised key bound was rejected: %v", err)
	}
	overKeys := liveViewDraftWithRoot(minimalLiveViewComponent(t, "Value"))
	overKeys["data"] = fullData(maxLiveViewDataKeys + 2)
	if err := marshalAndValidate(t, overKeys); err == nil {
		t.Fatal("data above the advertised key bound was accepted")
	}

	textAtBound := liveViewDraftWithRoot(map[string]any{"type": "Text", "text": strings.Repeat("a", maxLiveViewText)})
	if err := marshalAndValidate(t, textAtBound); err != nil {
		t.Fatalf("text at the advertised bound was rejected: %v", err)
	}
	textOverBound := liveViewDraftWithRoot(map[string]any{"type": "Text", "text": strings.Repeat("a", maxLiveViewText+1)})
	if err := marshalAndValidate(t, textOverBound); err == nil {
		t.Fatal("text above the advertised bound was accepted")
	}
	labelOverBound := liveViewDraftWithRoot(map[string]any{
		"type": "Button", "label": strings.Repeat("a", maxLiveViewLabel+1),
		"action": map[string]any{"type": "increment", "path": "count", "amount": 1},
	})
	if err := marshalAndValidate(t, labelOverBound); err == nil {
		t.Fatal("label above the advertised bound was accepted")
	}

	zeroRevision := liveViewDraftWithRoot(minimalLiveViewComponent(t, "Value"))
	zeroRevision["revision"] = 0
	if err := marshalAndValidate(t, zeroRevision); err == nil {
		t.Fatal("revision below the advertised minimum was accepted")
	}

	for _, amount := range []float64{-liveViewIncrementBound, liveViewIncrementBound} {
		surface := liveViewDraftWithRoot(map[string]any{
			"type": "Button", "label": "ok",
			"action": map[string]any{"type": "increment", "path": "count", "amount": amount},
		})
		if err := marshalAndValidate(t, surface); err != nil {
			t.Fatalf("increment amount %v at the advertised bound was rejected: %v", amount, err)
		}
	}
	for _, amount := range []float64{0, liveViewIncrementBound + 1, -liveViewIncrementBound - 1} {
		surface := liveViewDraftWithRoot(map[string]any{
			"type": "Button", "label": "ok",
			"action": map[string]any{"type": "increment", "path": "count", "amount": amount},
		})
		if err := marshalAndValidate(t, surface); err == nil {
			t.Fatalf("increment amount %v outside the advertised bounds was accepted", amount)
		}
	}
}

func marshalAndValidate(t *testing.T, surface map[string]any) error {
	t.Helper()
	data, err := json.Marshal(surface)
	if err != nil {
		t.Fatal(err)
	}
	return validateTaskLiveViewJSON(data)
}

func TestLiveViewDescribeCommandRoutesAndEmitsJSON(t *testing.T) {
	output, code := runCli(t, "live-view", "describe", "--json")
	if code != 0 {
		t.Fatalf("live-view describe --json exited %d: %s", code, output)
	}
	var descriptor struct {
		Contract   string           `json:"contract"`
		Snapshot   map[string]any   `json:"snapshot"`
		Limits     map[string]any   `json:"limits"`
		Components []map[string]any `json:"components"`
		Actions    []map[string]any `json:"actions"`
		Rules      []string         `json:"rules"`
		Examples   []map[string]any `json:"examples"`
	}
	if err := json.Unmarshal([]byte(output), &descriptor); err != nil {
		t.Fatalf("describe output is not valid JSON: %v\n%s", err, output)
	}
	if descriptor.Contract != "free4chat.task-live-view" ||
		len(descriptor.Snapshot) == 0 || len(descriptor.Limits) == 0 ||
		len(descriptor.Components) != len(liveViewComponentTypes) ||
		len(descriptor.Actions) != len(liveViewActionTypes) ||
		len(descriptor.Rules) == 0 || len(descriptor.Examples) == 0 {
		t.Fatalf("describe output is incomplete: %s", output)
	}
	// A freshly installed binary answers without a daemon or Room credentials:
	// the same invocation without --json must produce the same machine shape.
	plain, plainCode := runCli(t, "live-view", "describe")
	if plainCode != 0 || plain != output {
		t.Fatalf("describe output must not depend on a daemon: code=%d", plainCode)
	}
	if _, code := runCli(t, "live-view", "describe", "--yaml"); code != 2 {
		t.Fatalf("unknown describe flag should exit 2, got %d", code)
	}
	if _, code := runCli(t, "live-view"); code != 2 {
		t.Fatalf("bare live-view should exit 2, got %d", code)
	}
}

func TestLiveViewPublishPreflightIsUnchanged(t *testing.T) {
	if _, code := runCli(t, "live-view", "publish", "--task-request-id", "req-1"); code != 2 {
		t.Fatal("publish without --file should exit 2")
	}
	if _, code := runCli(t, "live-view", "publish", "--file", "surface.json"); code != 2 {
		t.Fatal("publish without --task-request-id should exit 2")
	}

	// Local preflight still rejects an invalid draft before any daemon round
	// trip, exactly as before the describe command existed.
	dir := t.TempDir()
	invalid := filepath.Join(dir, "invalid.json")
	if err := os.WriteFile(invalid, []byte(`{"surfaceId":"counter"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	output, code := runCli(t, "live-view", "publish", "--task-request-id", "req-1", "--file", invalid)
	if code != 1 || !strings.Contains(output, "revision") {
		t.Fatalf("invalid draft must fail local preflight: code=%d output=%q", code, output)
	}

	valid := filepath.Join(dir, "valid.json")
	data, err := json.Marshal(validLiveViewDraft())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(valid, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateTaskLiveViewJSON(data); err != nil {
		t.Fatalf("the publish fixture must stay valid: %v", err)
	}
}
