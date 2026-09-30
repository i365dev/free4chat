package cli

import "github.com/i365dev/free4chat/agent/internal/generatedapp"

const (
	generatedAppHTMLBytes  = generatedapp.MaxHTMLBytes
	generatedAppCSSBytes   = generatedapp.MaxCSSBytes
	generatedAppJSBytes    = generatedapp.MaxJSBytes
	generatedAppStateBytes = generatedapp.MaxStateBytes
)

// validateGeneratedAppBundle is the Runtime-side UX preflight. The Room
// repeats every check and remains the canonical security/capacity boundary.
func validateGeneratedAppBundle(data []byte, bundle map[string]any) error {
	return generatedapp.Validate(data, bundle)
}

type generatedAppDescriptor struct {
	Contract        string                   `json:"contract"`
	ContractVersion int                      `json:"contractVersion"`
	PublishCommand  string                   `json:"publishCommand"`
	Bundle          generatedAppBundleRule   `json:"bundle"`
	Limits          generatedAppLimits       `json:"limits"`
	StateBudget     generatedAppStateBudget  `json:"stateBudget"`
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

type generatedAppStateBudget struct {
	WindowMs        int `json:"windowMs"`
	MaxMutations    int `json:"maxMutations"`
	MaxPayloadBytes int `json:"maxPayloadBytes"`
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
		StateBudget: generatedAppStateBudget{
			WindowMs:        10_000,
			MaxMutations:    40,
			MaxPayloadBytes: 65_536,
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
			"free4chat.capabilities.observe(capabilityId)",
			"free4chat.capabilities.invoke(capabilityId, action, args)",
		},
		Rules: []string{
			"The bundle is self-contained HTML/CSS/JavaScript business code; the host supplies the sandbox and Room bridge.",
			"networkOrigins must be [] in V0; native network access is unavailable.",
			"A Human click may call the originating Task Agent Runtime through the host-owned capabilities bridge; capability results are semantic and bounded.",
			"Call observe/invoke synchronously inside the trusted click handler for the concrete control; one control click authorizes one operation.",
			"Do not select a runtimeHostId or include credentials, local endpoints, or device/network details in the App.",
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
