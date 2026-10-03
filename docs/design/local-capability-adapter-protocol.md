# Local Capability Adapter Protocol and V1 Runtime

**Status:** V1 shipped in Runtime `0.5.52`; Extension Lab #215 completed
production acceptance using an external Epson/CUPS Adapter and a Generated
Task App. This record preserves the original Phase-0 decision rationale and
tracks the implemented V1 boundary below.

## Decision

Use a supervised child process over **newline-delimited JSON on stdin/stdout (stdio)**. V1 has four operations: `list`, `describe`, `observe`, and `invoke`. Each request and response is one UTF-8 JSON object followed by LF. Logs belong on stderr. There is no initialize handshake: `protocolVersion: 1` on every envelope provides an unambiguous version check, and `list` is the first useful operation.

The Adapter is an ordinary executable in Python, Node, Go, or another language with line-oriented stdin/stdout. It imports no Free4Chat package. The descriptor uses the existing `RuntimeCapabilityProjection` semantic shape from `agent/internal/types/types.go`; the protocol does not define a second action schema.

## Why stdio

| Concern | stdio child process | Unix domain socket / local IPC |
| --- | --- | --- |
| Runtime implementation | Start, write a frame, read a frame, reap a child | Create/listen/connect, choose a socket path, manage permissions and stale sockets |
| Agent authoring | Standard input/output and JSON in every common language | Usually supported, but APIs and path conventions differ by language/platform |
| Network exposure | No listener or port | No network listener, but a local endpoint still needs naming and access control |
| Ownership and crash detection | Parent owns process; EOF/exit is immediate evidence | Process ownership and socket lifetime must be coordinated separately |
| Correlation / cancellation | Request ID; one outstanding request; timeout kills and restarts child | Request ID still needed; cancellation and disconnect policy still needed |
| Bounded framing | One bounded line per message | Must define framing over a byte stream too |
| Long-lived / multiple capabilities | One long-lived process can serve a bounded list | Also possible, with more lifecycle machinery |
| macOS / Linux / Windows | Same basic process pipes on all three | Unix sockets are not uniformly available; Windows needs a separate named-pipe equivalent |

For the current use case, stdio covers the needed behavior while keeping process ownership explicit and cross-platform. Socket IPC does not remove framing, correlation, or cancellation decisions. Revisit only if measured throughput or bidirectional event streaming requires it.

## Protocol messages

The maximum encoded frame is **65,536 bytes including LF**. JSON must be UTF-8, one object per line, with no blank lines. The Runtime sends one request at a time per Adapter process. IDs are unique per process lifetime, 1–64 printable ASCII characters. The Adapter returns exactly one response with the same ID for each accepted request.

Request envelope:

```json
{"protocolVersion":1,"id":"7","method":"describe","capabilityId":"living_room_light"}
```

Success envelope:

```json
{"protocolVersion":1,"id":"7","result":{"capabilityId":"living_room_light","title":"Living room light","version":"1","observe":true,"actions":[]}}
```

Error envelope:

```json
{"protocolVersion":1,"id":"7","error":{"code":"unsupported_action"}}
```

Methods and arguments:

- `list`: no arguments; returns an array of semantic descriptors.
- `describe`: `capabilityId`; returns one descriptor.
- `observe`: `capabilityId`; returns a JSON value bounded as below.
- `invoke`: `capabilityId`, `action`, and `args`; returns a JSON value bounded as below.

Descriptor fields are the existing Room projection fields: `capabilityId`, `title`, `version`, `observe` (boolean), and `actions` (`name`, `title`, `input`). `input` is the existing closed object schema with primitive `string`, `number`, or `boolean` properties and optional `required` names. Descriptor bounds and forbidden integration/secret-shaped fields follow `RuntimeCapabilityProjection.Valid()`; the whole descriptor is at most 1,024 bytes. The protocol can carry up to eight descriptors in a bounded list, but production V1 requires exactly one: zero or multiple descriptors fail registration explicitly. Room/Runtime Host projection capacity remains one.

The protocol intentionally has no `health` call: a successful `list` is the readiness probe, and process exit/EOF signals loss of the Adapter. It has no `initialize` call because version is checked on each envelope. It has no protocol cancellation method: V1 has one in-flight call, and the Runtime cancels by closing/killing the child and starting a fresh process on a later request.

## Bounds and failures

- Frame: 65,536 bytes including LF.
- Request ID: 1–64 printable ASCII bytes; response ID and version must match the outstanding request.
- Descriptors: at most eight; each at most 1,024 encoded bytes; each descriptor follows the existing projection limits (64-character title, 32-character version, four actions, 16 properties per action, and the existing identifier/type/sensitive-field rules).
- Invoke `args`: at most 1,024 encoded JSON bytes.
- `observe` and `invoke` result: at most 4,096 encoded JSON bytes.
- Operation deadline: 1.5 seconds in the V1 supervisor.

Error codes are closed: `invalid_request`, `unsupported_method`, `unknown_capability`, `unsupported_action`, `invalid_args`, `unavailable`, `too_large`, and `internal`. Do not include vendor error text, endpoint values, or credentials in protocol errors. A timeout maps to `unavailable` at the protocol edge while the Runtime may retain a local timeout classification.

EOF, non-zero exit, timeout, malformed JSON, an oversized frame, wrong version/ID, duplicate response, or missing response means the current call fails closed as `unavailable`; the Runtime discards that child. A clean exit is expected only after the Runtime closes stdin during teardown. Stdout is protocol-only: no banners, debug output, progress, or stack traces. Send diagnostics to stderr, where the Runtime can bound and redact them.

## Runtime and Adapter responsibilities

**Runtime owns:** transport and frame validation; descriptor validation; Room projection and authorization; local execution approval; request IDs, timeout/correlation, bounds, and process lifecycle; unavailable state; registration and teardown. Room-facing capability calls continue to use the existing #512/#513 semantic contract.

**Adapter owns:** vendor/service discovery and protocol; local endpoint and device details; credentials/OAuth/tokens; BLE, serial, USB, IPP, MQTT, HTTP, or SDK use; integration-specific configuration and retries; mapping local data to the bounded descriptor and results.

Runtime must not become an arbitrary HTTP/TCP proxy or infer local authority from a Room request.

## Credential boundary

The protocol carries none of: vendor tokens/passwords, OAuth tokens, BLE pairing secrets, serial credentials, arbitrary environment values, or device IPs/endpoints. Runtime defines no credential schema or vault. Adapter configuration is read and stored by the Adapter in its own local files or native secret store. Do not put secrets in argv. The reference Adapter receives only a path to its non-secret fixture config; the config is outside Runtime configuration.

## Agent authoring and approval

```text
Operator explicitly registers a local executable and bounded argv
→ Runtime validates the Adapter descriptor and bounded behavior
→ Room projects one semantic capability under its existing authorization
→ Human explicitly clicks a Generated Task App control for one operation
→ result returns as bounded semantic data
```

`free4chat-agent capability adapter register --exec ... [--arg ...]` is the explicit local execution approval and stores only the command and bounded argv in a private Runtime config file. `capability adapter remove` unregisters it. Starting an executable does not publish its capability; Human Room publication/control approval remains separate. A Room capability request does not grant the Adapter filesystem, network, USB, or secret authority. V1 registrations are daemon-owned and persist across daemon restarts. Room/session-owned temporary Adapter cleanup is deferred; user-installed persistent processes are the supported V1 lifecycle. There is no installer or package manager.

## Migration from the #512/#513 fixture seam

| Current piece | V1 disposition | Evidence / implementation |
| --- | --- | --- |
| `agent/internal/types.RuntimeCapabilityProjection` and its validation | **KEEP GENERIC** | Semantic descriptor already excludes endpoint/config/credentials and bounds Room projection. Reuse its wire shape. |
| Runtime capability request dispatch and Room authorization/correlation | **KEEP GENERIC** | `agent/internal/runtime/runtime.go`, `agent/internal/daemon/capability_controller.go`, and `agent/internal/free4chat/resident_events.go` carry semantic operations, not vendor routes. Keep these on the Runtime side. |
| `agent/internal/capability.Controller` bounds/error normalization | **KEEP GENERIC** | It validates semantic descriptors and typed action args, and bounds request/result payloads. Fixture ID and color policy are removed. |
| `agent/internal/capability/fixture_http.go` | **REMOVED** | `agent/internal/capability/process.go` owns generic stdio framing/lifecycle. HTTP routes exist only in the experimental Python Adapter. |
| `agent/internal/capability/config.go` | **REPLACED** | `capability-adapter.json` persists only executable and bounded argv with private file permissions. Adapter config remains Adapter-owned. |
| Daemon `capability-configure` / `FixtureEndpoint` IPC and controller replacement | **REPLACED** | `capability-adapter-register/remove` starts, atomically replaces, or stops the daemon-owned process and refreshes live Runtime Host projection. Process exit clears the current projection. |
| `agent/internal/cli` `capability configure --fixture-endpoint` | **REMOVED** | `capability adapter register/remove` manages only local process identity; semantic `list`, `describe`, `observe`, and `invoke` remain unchanged. |
| Harness instructions and semantic capability CLI | **KEEP GENERIC** | The prompt uses descriptor-provided IDs/actions and local policy; remove only fixture assumptions if any enter it. |
| Python reference Adapter / fixture / validator in `agent/experimental/local-capability-adapter/` | **PROOF-ONLY** | Executable spec evidence, outside production Runtime packages and dependencies. |
| Current Go fixture tests | **REPLACED** | Focused conformance, lifecycle, timeout, bounds, process failure, and Python reference dogfood tests exercise the external seam. |

V1 ships one capability projection per Runtime Host. It has no package
registry/installer and no Room-owned ephemeral Adapter lifecycle. Multi-
capability expansion or temporary Room-owned Adapter lifecycle requires later
evidence; neither is implied by the protocol's bounded list framing.

## Threat model

Treat the Adapter as separately approved local code, not as trusted because its descriptor is valid. A malicious or buggy Adapter can still exercise whatever local OS/network authority the operator grants its process. V1 reduces accidental authority leakage and protocol resource abuse with strict schemas, finite frames/results, one outstanding request, deadlines, secret-free requests/results, fail-closed process replacement, and separate Room publication approval. It does not sandbox Adapter code; OS/Harness policy remains the execution boundary.

## Non-goals

- Device discovery framework, package manager, registry, marketplace, SDK, or automatic code installation.
- Xiaomi, Home Assistant, Epson/CUPS, BLE, MQTT, serial, USB, or vendor integration in Runtime.
- Runtime credential storage or universal secret schema.
- Arbitrary local network proxying.
- Protocol streaming, unsolicited Adapter events, multiple in-flight requests, or socket transport.
- Changing #512 release/version work.

## Fixture integration proof

The reference adapter `living_room_light` translates `observe` to the deterministic fixture `GET /state` and `invoke(set_led)` to `POST /actions/set-led`. The endpoint exists only in an Adapter-owned config file. Production daemon tests register this Python process, route an Agent's Generated Task App capability RPC through the resident Runtime controller, replace the process, and verify process crash clears projection. A second Adapter for any other fixture/device can expose the same descriptor/action semantics while changing only its local implementation/config; Room/Core/Runtime continue to see `list / describe / observe / invoke` and bounded semantic JSON.

## Production reuse proof

Extension Lab #215 completed the participant-local path with a real
Epson/CUPS Adapter under Runtime `0.5.52` and production Web/Core. The Adapter
owns CUPS discovery and queue details; Runtime projects the read-only
`printer_status` semantic capability; a Generated Task App provides the Human
control surface and receives only the bounded status result. The Lab recorded
final real Epson/CUPS acceptance. This is reuse evidence for the existing
Runtime/Adapter seam, not vendor functionality in Core or Runtime.
