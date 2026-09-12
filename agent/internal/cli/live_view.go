package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

const (
	maxLiveViewComponents = 64
	maxLiveViewDepth      = 8
	maxLiveViewDataKeys   = 32
	maxLiveViewText       = 400
	maxLiveViewLabel      = 80
	// minLiveViewRevision and liveViewIncrementBound are the canonical action
	// and revision bounds. The validator and the machine-readable contract
	// descriptor both read them, so they cannot drift.
	minLiveViewRevision    = 1
	liveViewIncrementBound = 1000
)

var (
	liveViewIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
	liveViewDataPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
)

// liveViewComponentTypes and the field tables below are the single canonical
// Live View vocabulary. validateTaskLiveViewJSON enforces exactly what they
// declare, and describeTaskLiveView renders them as the machine-readable
// authoring contract, so an allowed-field or supported-type change cannot
// silently diverge between the local preflight and what a Harness is told.
var (
	liveViewComponentTypes = []string{"Text", "Value", "Button", "Input", "Row", "Column", "Card"}

	liveViewComponentFields = map[string][]string{
		"Text":   {"type", "text"},
		"Value":  {"type", "path"},
		"Button": {"type", "label", "action"},
		"Input":  {"type", "path", "placeholder"},
		"Row":    {"type", "children"},
		"Column": {"type", "children"},
		"Card":   {"type", "children"},
	}

	liveViewComponentRequiredFields = map[string][]string{
		"Text":   {"type", "text"},
		"Value":  {"type", "path"},
		"Button": {"type", "label", "action"},
		"Input":  {"type", "path"},
		"Row":    {"type", "children"},
		"Column": {"type", "children"},
		"Card":   {"type", "children"},
	}

	liveViewActionTypes = []string{"increment", "set"}

	liveViewActionFields = map[string][]string{
		"increment": {"type", "path", "amount"},
		"set":       {"type", "path", "value"},
	}
)

// liveViewActionSupported reports whether the canonical action table accepts
// this action type.
func liveViewActionSupported(actionType string) bool {
	_, ok := liveViewActionFields[actionType]
	return ok
}

// liveViewOptionalFields are the allowed fields that are not required.
func liveViewOptionalFields(required, allowed []string) []string {
	optional := make([]string, 0, len(allowed))
	for _, field := range allowed {
		present := false
		for _, requiredField := range required {
			if field == requiredField {
				present = true
				break
			}
		}
		if !present {
			optional = append(optional, field)
		}
	}
	return optional
}

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
	if revision, ok := object["revision"].(float64); !ok || revision < minLiveViewRevision || revision != float64(int64(revision)) {
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
	// The canonical field table is both the supported-type set and the
	// allowed-field set; the switch below only enforces per-type semantics.
	fields, known := liveViewComponentFields[typeName]
	if !known {
		return fmt.Errorf("Live View contains unknown component %q", typeName)
	}
	if err := liveViewOnlyKeys(component, fields...); err != nil {
		return err
	}
	switch typeName {
	case "Text":
		if text, ok := component["text"].(string); !ok || !safeLiveViewText(text, maxLiveViewText) {
			return fmt.Errorf("Live View Text requires bounded safe text")
		}
	case "Value":
		if _, err := liveViewPath(component, "Value"); err != nil {
			return err
		}
	case "Input":
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
		label, ok := component["label"].(string)
		if !ok || !safeLiveViewText(label, maxLiveViewLabel) {
			return fmt.Errorf("Live View Button requires a bounded label")
		}
		action, ok := component["action"].(map[string]any)
		if !ok {
			return fmt.Errorf("Live View Button requires an action")
		}
		actionType, ok := action["type"].(string)
		if !ok || !liveViewActionSupported(actionType) {
			return fmt.Errorf("Live View action type %q is unsupported", actionType)
		}
		path, err := liveViewPath(action, "Button action")
		if err != nil {
			return err
		}
		if err := liveViewOnlyKeys(action, liveViewActionFields[actionType]...); err != nil {
			return err
		}
		switch actionType {
		case "increment":
			amount, ok := action["amount"].(float64)
			if !ok || amount == 0 || amount != float64(int64(amount)) || amount < -liveViewIncrementBound || amount > liveViewIncrementBound {
				return fmt.Errorf("Live View increment amount must be a non-zero integer between -%d and %d", liveViewIncrementBound, liveViewIncrementBound)
			}
			if _, ok := data[path].(float64); !ok {
				return fmt.Errorf("Live View increment path %q must reference a number data key", path)
			}
		case "set":
			if !validLiveViewScalar(action["value"]) {
				return fmt.Errorf("Live View set value must be a string, number, or boolean")
			}
		}
	case "Row", "Column", "Card":
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

// liveViewDescriptor is the machine-readable Live View authoring contract
// returned by `live-view describe --json`. Every value below is derived from
// the constants and canonical tables that validateTaskLiveViewJSON enforces,
// so the descriptor cannot describe a different contract than the local
// preflight rejects or accepts. It is intentionally self-contained: a freshly
// installed binary answers it without a source checkout, repository docs,
// binary strings, network access, or Room credentials.
type liveViewDescriptor struct {
	Contract        string               `json:"contract"`
	ContractVersion int                  `json:"contractVersion"`
	PublishCommand  string               `json:"publishCommand"`
	Snapshot        liveViewSnapshotRule `json:"snapshot"`
	Limits          liveViewLimits       `json:"limits"`
	Components      []liveViewTypeRule   `json:"components"`
	Actions         []liveViewTypeRule   `json:"actions"`
	Rules           []string             `json:"rules"`
	Examples        []liveViewExample    `json:"examples"`
}

// liveViewExample is one minimal valid draft. The explicit field order keeps
// the emitted example in authoring order instead of Go's sorted map order.
type liveViewExample struct {
	SurfaceID string         `json:"surfaceId"`
	Revision  int            `json:"revision"`
	Root      map[string]any `json:"root"`
	Data      map[string]any `json:"data"`
}

type liveViewSnapshotRule struct {
	RequiredFields   []string `json:"requiredFields"`
	OptionalFields   []string `json:"optionalFields"`
	OptionalFieldUse string   `json:"optionalFieldUse"`
	SurfaceIDPattern string   `json:"surfaceIdPattern"`
	RevisionMin      int      `json:"revisionMin"`
	DataKeyPattern   string   `json:"dataKeyPattern"`
	RootComponent    string   `json:"rootComponent"`
}

type liveViewLimits struct {
	MaxJSONBytes            int `json:"maxJsonBytes"`
	MaxComponents           int `json:"maxComponents"`
	MaxDepth                int `json:"maxDepth"`
	MaxDataKeys             int `json:"maxDataKeys"`
	MaxTextLength           int `json:"maxTextLength"`
	MaxLabelLength          int `json:"maxLabelLength"`
	MaxChildrenPerContainer int `json:"maxChildrenPerContainer"`
	IncrementAmountMin      int `json:"incrementAmountMin"`
	IncrementAmountMax      int `json:"incrementAmountMax"`
}

type liveViewTypeRule struct {
	Type           string   `json:"type"`
	RequiredFields []string `json:"requiredFields"`
	OptionalFields []string `json:"optionalFields"`
	Rules          []string `json:"rules"`
}

// describeTaskLiveView renders the canonical contract.
func describeTaskLiveView() liveViewDescriptor {
	components := make([]liveViewTypeRule, 0, len(liveViewComponentTypes))
	for _, typeName := range liveViewComponentTypes {
		allowed := liveViewComponentFields[typeName]
		components = append(components, liveViewTypeRule{
			Type:           typeName,
			RequiredFields: append([]string(nil), liveViewComponentRequiredFields[typeName]...),
			OptionalFields: liveViewOptionalFields(liveViewComponentRequiredFields[typeName], allowed),
			Rules:          liveViewComponentRules(typeName),
		})
	}
	actions := make([]liveViewTypeRule, 0, len(liveViewActionTypes))
	for _, actionType := range liveViewActionTypes {
		actions = append(actions, liveViewTypeRule{
			Type:           actionType,
			RequiredFields: append([]string(nil), liveViewActionFields[actionType]...),
			OptionalFields: []string{},
			Rules:          liveViewActionRules(actionType),
		})
	}
	return liveViewDescriptor{
		Contract:        "free4chat.task-live-view",
		ContractVersion: 1,
		PublishCommand:  "live-view publish --task-request-id <request-id> --file <surface.json> [--instance <id>]",
		Snapshot: liveViewSnapshotRule{
			RequiredFields:   []string{"surfaceId", "revision", "root", "data"},
			OptionalFields:   []string{"taskRequestId", "authorityAgentId"},
			OptionalFieldUse: "optional legacy snapshot fields: the host supplies Task and Agent identity and the Room replaces these with authenticated values",
			SurfaceIDPattern: liveViewIDPattern.String(),
			RevisionMin:      minLiveViewRevision,
			DataKeyPattern:   liveViewDataPattern.String(),
			RootComponent:    "exactly one component object; counts as depth 1",
		},
		Limits: liveViewLimits{
			MaxJSONBytes:            maxTaskLiveViewBytes,
			MaxComponents:           maxLiveViewComponents,
			MaxDepth:                maxLiveViewDepth,
			MaxDataKeys:             maxLiveViewDataKeys,
			MaxTextLength:           maxLiveViewText,
			MaxLabelLength:          maxLiveViewLabel,
			MaxChildrenPerContainer: maxLiveViewComponents,
			IncrementAmountMin:      -liveViewIncrementBound,
			IncrementAmountMax:      liveViewIncrementBound,
		},
		Components: components,
		Actions:    actions,
		Rules: []string{
			"surfaceId is the stable identity of one Task surface; start a new surface with a new id",
			"revision must be an integer >= 1; start at 1 and replace the same surfaceId only with a strictly higher revision",
			"data is a flat object of at most " + strconv.Itoa(maxLiveViewDataKeys) + " keys; each value is a boolean, a finite number, or a safe string",
			"binding: Value.path reads data[path]; Input.path must reference a declared string data key; an increment action path must reference a declared number data key",
			"safe string: non-empty, no '<' or '>', no case-insensitive javascript:, http://, https://, or data:, and length counted in UTF-16 code units like JavaScript String.length (max " + strconv.Itoa(maxLiveViewText) + " for data/Text, max " + strconv.Itoa(maxLiveViewLabel) + " for labels and placeholders)",
			"components: at most " + strconv.Itoa(maxLiveViewComponents) + " total in the whole tree; the root component is depth 1 and nesting may not exceed depth " + strconv.Itoa(maxLiveViewDepth),
			"container children: an array of 1 to " + strconv.Itoa(maxLiveViewComponents) + " component objects",
			"actions are browser-local updates for the viewer; they never send a Room message and never start an Agent turn",
			"publish the draft as one JSON object of at most " + strconv.Itoa(maxTaskLiveViewBytes) + " bytes; never put credentials in the file",
		},
		Examples: liveViewExamples(),
	}
}

func liveViewComponentRules(typeName string) []string {
	switch typeName {
	case "Text":
		return []string{"text: safe string of at most " + strconv.Itoa(maxLiveViewText) + " characters"}
	case "Value":
		return []string{"path: data key pattern; renders data[path] when the key is declared"}
	case "Button":
		return []string{
			"label: safe string of at most " + strconv.Itoa(maxLiveViewLabel) + " characters",
			"action: exactly one increment or set action",
		}
	case "Input":
		return []string{
			"path: data key pattern; must reference a declared string data key",
			"placeholder: optional safe string of at most " + strconv.Itoa(maxLiveViewLabel) + " characters",
		}
	case "Row", "Column", "Card":
		return []string{"children: 1 to " + strconv.Itoa(maxLiveViewComponents) + " component objects at depth + 1"}
	}
	return nil
}

func liveViewActionRules(actionType string) []string {
	switch actionType {
	case "increment":
		return []string{
			"path must reference a declared number data key",
			"amount must be a non-zero integer between " + strconv.Itoa(-liveViewIncrementBound) + " and " + strconv.Itoa(liveViewIncrementBound),
		}
	case "set":
		return []string{"value must be a safe string, a number, or a boolean"}
	}
	return nil
}

// liveViewExamples returns one or two minimal valid drafts. They are covered
// by a test that runs each through validateTaskLiveViewJSON, so an example can
// never advertise a shape the local preflight rejects.
func liveViewExamples() []liveViewExample {
	return []liveViewExample{
		{
			SurfaceID: "counter",
			Revision:  1,
			Root: map[string]any{
				"type": "Card",
				"children": []any{
					map[string]any{"type": "Value", "path": "count"},
					map[string]any{
						"type": "Button", "label": "+1",
						"action": map[string]any{"type": "increment", "path": "count", "amount": 1},
					},
				},
			},
			Data: map[string]any{"count": 0},
		},
		{
			SurfaceID: "task-board",
			Revision:  1,
			Root: map[string]any{
				"type": "Column",
				"children": []any{
					map[string]any{"type": "Text", "text": "Review status"},
					map[string]any{"type": "Input", "path": "note", "placeholder": "Short note"},
					map[string]any{
						"type": "Row",
						"children": []any{
							map[string]any{"type": "Value", "path": "votes"},
							map[string]any{
								"type": "Button", "label": "Approve",
								"action": map[string]any{"type": "increment", "path": "votes", "amount": 1},
							},
							map[string]any{
								"type": "Button", "label": "Reset note",
								"action": map[string]any{"type": "set", "path": "note", "value": "todo"},
							},
						},
					},
				},
			},
			Data: map[string]any{"note": "todo", "votes": 0, "reviewed": false},
		},
	}
}
