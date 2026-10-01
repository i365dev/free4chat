# Generated Task App authoring format probe

**Scope:** approved narrow implementation. This report and implementation start from `cf-sfu` `6a0a33e65a0b7b3fad4a89427b4d516aa4d097de` (#535). The Agent-facing authoring contract changes to HTML; the internal bundle, Room publication, and Room App Host contracts stay unchanged. No Runtime is released in this PR.

## CURRENT AUTHORING PATH

A Task-scoped turn asks the Harness to append a text envelope whose payload is a JSON `GeneratedRoomAppBundle`:

```text
[[free4chat:task-output generated-app]]
{"version":1,"manifest":{"title":"...","networkOrigins":[]},"html":"...","css":"...","js":"...","initialState":{}}
[[/free4chat:task-output]]
```

The ACP v1 adapter accumulates only `text` content from `agent_message_chunk` updates. `ParseHarnessTurnResult` finds the terminal marker, decodes one bounded JSON object, rejects unknown fields, and calls the Go Generated App validator. The Task-only gate and Room publication path remain downstream of this parser.

## WHY DOGFOOD FAILED

The Agent had to satisfy two independent encodings at once: first the Free4Chat marker grammar, then JSON string escaping for HTML, CSS, and JavaScript nested inside a text response. #535 fixed one marker-placement failure (opening token sharing a line with JSON); it could not prevent quotes, backslashes, and newlines in otherwise sound source from breaking JSON. This is an **authoring serialization problem**, not a missing package/container format.

## STANDARD OPTIONS REVIEWED

| Option | Agent/text friendliness | Cost and compatibility | Decision |
| --- | --- | --- | --- |
| Self-contained HTML | Excellent; code and markup use their normal syntax | One mature HTML5 parse, narrow extraction rules, no provider matrix | **Best fit** |
| MIME multipart / MHTML | Weak; boundary and header encoding are another envelope | Requires MIME framing/parser and content-part policy; no benefit for one document | Reject |
| ZIP/tar | Poor in text-only turns; base64 adds escaping and size overhead | Archive extraction, file/path policy, binary provider support matrix | Reject |
| Web Bundle | Poor for model-authored output | More format machinery, signing/verification and browser support concerns | Reject |

The job is one small document, not a multi-file package. HTML already provides the needed source container. Do not add a Free4Chat DSL, archive, build system, or provider-specific output protocol.

## ACP RESOURCE REALITY

The Runtime negotiates ACP **v1**. ACP defines content blocks, including an embedded `resource` with text plus an optional MIME type, and documents content blocks in streamed `session/update` message output. That makes a `text/html` resource a possible future transport shape at the protocol level ([ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json), [ACP content documentation](https://agentclientprotocol.com/protocol/content)).

It is not usable in the current Free4Chat path: `extractTextChunk` discards every non-`text` block, `HarnessTurnResult` carries a string, and the generated-app parser consumes that string. The built-in five providers are Codex (pinned `codex-acp` bridge), Claude (`claude-agent-acp` bridge), Pi (`pi-acp` bridge), Hermes (`hermes acp`), and OpenCode (`opencode acp --pure`). They all share that adapter. The repository contains no provider-specific `text/html` resource forwarding or runtime evidence that any of the five emits one for a completed Task turn. Therefore protocol support is real, but provider support is **not established and is not available through this adapter today**. A future resource transport can feed the same HTML normalizer; it should not be a prerequisite for V1.

## RECOMMENDED AGENT AUTHORING FORMAT

Use one ordinary, complete, self-contained HTML document as the public Agent source, carried verbatim as the payload of the existing Task-output text block. The marker remains framing; the payload stops being JSON. V1 deliberately accepts only a narrow subset:

- Require a document with one non-empty `<title>` (≤80 UTF-8 bytes), a `<head>`, and a `<body>`.
- Keep styles inline in one or more `<style>` elements in `<head>`; combine their text in document order.
- Allow zero or one executable classic inline `<script>` at the end of `<body>`. If present, it must be the final meaningful body child. Reject multiple scripts, external `src`, module, async/defer, and scripts in `<head>` because combining multiple script elements can change execution semantics and the current bundle executes one classic JS field after bridge setup.
- Use body markup for the app. Reject external stylesheet/resource links. `initialState` is `{}` in V1; application meaning and UI state stay in Agent-authored code.
- The document title becomes `manifest.title`. No custom metadata block is needed.

A mature HTML5 parser (the Go `golang.org/x/net/html` parser already present in the dependency graph is a candidate) must walk the document tree. Do not extract with regex. Preserve node order when serializing body markup; concatenate style text in source order; reject source constructs that cannot be represented without changing their intended execution order. HTML parser recovery is deterministic, but the implementation should normalize through that parser and fail closed when required document structure/title or the representable subset is missing. If no script or style is present, use a non-empty internal comment placeholder to satisfy existing V1 source validation; the Agent does not need to author one.

## RECOMMENDED INTERNAL FORMAT

Keep `GeneratedRoomAppBundle` V1 **internal** and unchanged: `{version, manifest, html, css, js, initialState}`. The validator, Room's canonical validation/publication, bundle storage, and host already use this contract. Converting an authoring document to this bundle is a small ingress adapter; changing storage and every validator to retain one full document would churn a working internal contract and still require safe bridge/CSP injection into the document.

The public authoring contract is **self-contained HTML**. The internal persistence contract remains the existing JSON bundle. The marker is only the current transport framing, not a packaging standard.

## NORMALIZATION FLOW

```text
ACP v1 streamed text (today) ─┐
ACP resource text/html (future) ├→ Task output framing → HTML5 authoring normalizer
                               ┘                         → existing bundle V1
                                                         → existing Runtime validator
                                                         → existing Task/Room publication
                                                         → existing Room App Host
```

The normalizer first caps raw HTML at 48 KiB UTF-8 so parsing stays bounded, then derives title, body markup, CSS, and JavaScript; sets `networkOrigins: []` and `initialState: {}`; and invokes the current bundle validator. Keep the current total serialized bundle limit of 48 KiB and per-field limits (HTML 20 KiB, CSS 12 KiB, JS 32 KiB), strict Task correlation, and independent Room-side validation. Reject oversize or non-representable input; never truncate it.

## ROOM APP CAPABILITIES PRESERVED

Only the authoring ingress changes. The normalized bundle enters the existing Generated Task Room App publication and the same `RoomAppHost` / `generatedRoomAppSrcDoc()` path used by other Room Apps. Its bridge injection remains host-owned and precedes app JS. RoomAppHost already handles the generic `sendReliable`, `sendRealtime`, `sendReliableTo`, and inbound reliable/realtime/unicast messages for generated Apps as well as curated Apps; it does not filter these transport messages by `source === "generated"`. The existing generated-App facade does not expose methods that send those three outbound message types, so generated App code cannot currently use them through `window.free4chat`.

This is a narrow existing generated-facade/API parity gap, not a second collaboration runtime. The authoring normalizer must not fix or expand it. Generated Task Apps remain on the same RoomAppHost and Room transports; their existing shared-state path supplies Room collaboration today.

## SECURITY / VALIDATION

Retain the exact current `safeSource` checks: reject NUL, `</script`, `<iframe`, `<object`, `<embed`, and `javascript:` in source; keep `sandbox="allow-scripts"` without `allow-same-origin`; retain the generated-app CSP (`default-src 'none'`, inline-only style/script, `connect-src 'none'`, `img-src data:`); preserve empty `networkOrigins`, bundle/state/message/rate bounds, explicit Human Open, bridge authorization, and Room validation. Do not introduce network permissions as part of normalization.

Inline event handlers are currently permitted by the inline-script CSP and source validator; keep that behavior for this format decision. The existing bridge still gates capability calls on a trusted control click. External links/resources do not gain a host capability, and `javascript:` remains rejected. Any change to these rules is a separate security/design decision.

Multiple style blocks are concatenated in document order. V1 accepts zero or one classic inline script, which must be the final meaningful child of `<body>`; multiple executable scripts are rejected. Scripts in `<head>` and execution-order-sensitive placements are rejected rather than silently moved. Standard HTML parsing gives deterministic recovery for malformed markup; only the documented subset is accepted, and normalized output still passes the unchanged strict bundle validator. Add parser fixtures when implementation is approved.

## HARNESS COMPATIBILITY

The existing terminal text envelope works for all five Harnesses and remains the V1 path; replacing JSON payload with raw HTML removes source-string escaping pressure without changing ACP, provider launchers, or turns. ACP `resource` blocks may later be added as another input source to the same normalizer after actual provider behavior and adapter changes are verified. Do not claim a provider emits structured HTML resources merely because ACP defines the type.

## IMPLEMENTATION SURFACE

If approved, keep the patch focused:

1. Add a small Go HTML authoring normalizer in `agent/internal/generatedapp`, using an HTML5 parser.
2. Update `agent/internal/harness/prompt.go` to ask for one complete HTML document in the current terminal block.
3. Update `agent/internal/harness/task_output.go` to parse bounded raw HTML, normalize it, and call the existing validator; retain marker terminality, Task-only gating, and control mutual exclusion.
4. Update prompt/parser tests and `docs/en/guides/interactive-task-outputs.md` with the accepted HTML subset and one source example.
5. Leave `app/src/common/generatedRoomApp.ts`, Room publication/storage, and Room App Host unchanged.

This implementation changes the Agent Runtime's authoring contract. It requires a new official Runtime release before production dogfood can use it. ACP resource transport and a live-provider structured-resource matrix are not prerequisites. Do not make a Runtime release as part of this implementation task.

## WHAT MUST NOT CHANGE

Do not create a new Task App/App type, UI DSL, DAG, component framework, generic packaging/build system, npm/Vite/esbuild path, new Harness tool/protocol, or Codex-specific path. Do not modify the Runtime/Room bridge, shared-state/collaboration model, capability policy, Room lifecycle, or the internal bundle in this authoring-format change.

## RECOMMENDATION: IMPLEMENT

Implement self-contained HTML as the Agent-facing authoring source and normalize it to the existing internal bundle. The dogfood failures point to serialization, not packaging. A narrow HTML5-parsed subset has bounded implementation cost and preserves the already-proven internal publication and host boundary. Keep the internal bundle private and stable; defer ACP resource transport until a provider and the generic adapter demonstrably deliver it. Production dogfood requires a later official Runtime release; this PR does not release it.

## Concrete printer-status example

### 1. Agent authors ordinary HTML

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Printer</title>
  <style>body { font: 16px sans-serif; } .ok { color: green; }</style>
</head>
<body>
  <h1>Printer</h1>
  <p>Status: <span id="status">Loading</span></p>
  <button id="refresh">Refresh</button>
  <script>
    const status = document.querySelector("#status");
    document.querySelector("#refresh").addEventListener("click", async () => {
      const result = await free4chat.capabilities.observe("printer_status");
      status.textContent = result.ok ? JSON.stringify(result.value) : result.error;
    });
  </script>
</body>
</html>
```

### 2. Runtime normalizes to the existing internal shape

```json
{
  "version": 1,
  "manifest": { "title": "Printer", "networkOrigins": [] },
  "html": "<h1>Printer</h1><p>Status: <span id=\"status\">Loading</span></p><button id=\"refresh\">Refresh</button>",
  "css": "body { font: 16px sans-serif; } .ok { color: green; }",
  "js": "const status = document.querySelector(\"#status\"); document.querySelector(\"#refresh\").addEventListener(\"click\", async () => { const result = await free4chat.capabilities.observe(\"printer_status\"); status.textContent = result.ok ? JSON.stringify(result.value) : result.error; });",
  "initialState": {}
}
```

The example's JSON escaping is the Runtime's serialization work, not the Agent's authoring burden.

### 3. Existing Room App Host takes over

After validation and the existing Task-correlated publication, the Host loads the bundle into the same strict `srcDoc`, injects the current bridge before app JavaScript, and owns the MessagePort and Room capability request. The Human's Refresh click invokes the existing bounded `printer_status` capability flow; no direct printer/network access or Agent round trip is added.
