package cli

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

const (
	generatedAppHTMLBytes  = 20 * 1024
	generatedAppCSSBytes   = 12 * 1024
	generatedAppJSBytes    = 32 * 1024
	generatedAppStateBytes = 16 * 1024
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
	for _, field := range []struct {
		name string
		max  int
	}{
		{name: "html", max: generatedAppHTMLBytes},
		{name: "css", max: generatedAppCSSBytes},
		{name: "js", max: generatedAppJSBytes},
	} {
		source, ok := bundle[field.name].(string)
		if !ok || len(source) == 0 || len(source) > field.max || !safeGeneratedAppSource(source) {
			return fmt.Errorf("generated App %s is invalid", field.name)
		}
	}
	initialState, ok := bundle["initialState"].(map[string]any)
	if !ok || len(initialState) == 0 && initialState == nil {
		return fmt.Errorf("generated App initialState must be an object")
	}
	stateBytes, err := json.Marshal(initialState)
	if err != nil || len(stateBytes) > generatedAppStateBytes {
		return fmt.Errorf("generated App initialState exceeds 16 KiB")
	}
	return nil
}

func safeGeneratedAppSource(source string) bool {
	lower := strings.ToLower(source)
	return !strings.ContainsRune(source, '\x00') &&
		!strings.Contains(lower, "</script") &&
		!strings.Contains(lower, "<iframe") &&
		!strings.Contains(lower, "<object") &&
		!strings.Contains(lower, "<embed") &&
		!strings.Contains(lower, "javascript:")
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

type generatedAppDescriptor struct {
	Contract        string                   `json:"contract"`
	ContractVersion int                      `json:"contractVersion"`
	PublishCommand  string                   `json:"publishCommand"`
	Bundle          generatedAppBundleRule   `json:"bundle"`
	Limits          generatedAppLimits       `json:"limits"`
	Revision        generatedAppRevisionRule `json:"revision"`
	Bridge          []string                 `json:"bridge"`
	Rules           []string                 `json:"rules"`
	Examples        []generatedAppExample    `json:"examples"`
}

type generatedAppBundleRule struct {
	RequiredFields []string `json:"requiredFields"`
	Version        int      `json:"version"`
	NetworkOrigins []string `json:"networkOrigins"`
}

type generatedAppLimits struct {
	MaxBundleBytes int `json:"maxBundleBytes"`
	MaxHTMLBytes   int `json:"maxHtmlBytes"`
	MaxCSSBytes    int `json:"maxCssBytes"`
	MaxJSBytes     int `json:"maxJsBytes"`
	MaxStateBytes  int `json:"maxStateBytes"`
	MaxTitleLength int `json:"maxTitleLength"`
	MaxAppsPerRoom int `json:"maxAppsPerRoom"`
}

type generatedAppRevisionRule struct {
	FirstRevision    int    `json:"firstRevision"`
	SameTaskIdentity string `json:"sameTaskIdentity"`
	IdenticalRetry   string `json:"identicalRetry"`
	ChangedBundle    string `json:"changedBundle"`
	StateRevision    string `json:"stateRevision"`
}

type generatedAppExample struct {
	Description string         `json:"description"`
	Bundle      map[string]any `json:"bundle"`
}

func describeGeneratedApp() generatedAppDescriptor {
	return generatedAppDescriptor{
		Contract:        "free4chat.generated-task-app",
		ContractVersion: 1,
		PublishCommand:  "generated-app publish --task-request-id <request-id> --file <bundle.json> [--instance <id>]",
		Bundle: generatedAppBundleRule{
			RequiredFields: []string{"version", "manifest", "html", "css", "js", "initialState"},
			Version:        1,
			NetworkOrigins: []string{},
		},
		Limits: generatedAppLimits{
			MaxBundleBytes: maxGeneratedAppBytes,
			MaxHTMLBytes:   generatedAppHTMLBytes,
			MaxCSSBytes:    generatedAppCSSBytes,
			MaxJSBytes:     generatedAppJSBytes,
			MaxStateBytes:  generatedAppStateBytes,
			MaxTitleLength: 80,
			MaxAppsPerRoom: 4,
		},
		Revision: generatedAppRevisionRule{
			FirstRevision:    1,
			SameTaskIdentity: "one Task may have at most one Task App publication",
			IdenticalRetry:   "same Task and byte-identical bundle is an idempotent duplicate",
			ChangedBundle:    "same Task and changed valid bundle keeps appInstanceId and increments bundleRevision",
			StateRevision:    "bundleRevision and shared stateRevision are independent; updates preserve shared state",
		},
		Bridge: []string{
			"free4chat.app",
			"free4chat.self",
			"free4chat.participants",
			"free4chat.shared.get()",
			"free4chat.shared.set()",
			"free4chat.shared.revision",
			"free4chat.events.onSharedChange()",
			"free4chat.events.onParticipants()",
		},
		Rules: []string{
			"The bundle is self-contained HTML/CSS/JavaScript business code; the host supplies the sandbox and Room bridge.",
			"networkOrigins must be [] in V0; native network access is unavailable.",
			"Use shared.get() before a write, pass the returned revision through shared.set(), and handle a later shared change as the canonical state.",
			"A changed application bundle must tolerate or migrate any existing shared state schema itself.",
			"Never put credentials, participant handles, or private local data in the bundle or shared state.",
		},
		Examples: []generatedAppExample{{
			Description: "Minimal collaborative checklist",
			Bundle: map[string]any{
				"version":      1.0,
				"manifest":     map[string]any{"title": "Checklist", "networkOrigins": []any{}},
				"html":         "<main><input id=entry><button id=add>Add</button><ul id=list></ul></main>",
				"css":          "main { font: 16px sans-serif; }",
				"js":           "const input=document.querySelector('#entry'); const list=document.querySelector('#list'); const render=()=>{ const state=free4chat.shared.get(); list.replaceChildren(...(Array.isArray(state.items) ? state.items : []).map((item)=>{ const li=document.createElement('li'); li.textContent=String(item.text || ''); return li; })); }; document.querySelector('#add').onclick=()=>{ const value=input.value.trim(); if (!value) return; const state=free4chat.shared.get(); const items=Array.isArray(state.items) ? state.items : []; free4chat.shared.set({...state, items:[...items, {text:value}]}); input.value=''; }; free4chat.events.onSharedChange(render); render();",
				"initialState": map[string]any{"items": []any{}},
			},
		}},
	}
}
