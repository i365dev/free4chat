# Agent participation in Room Apps

A Room App can be more than a surface Humans open while an Agent talks about
the activity. An existing App can expose a bounded semantic contract so a
Human and an Agent work on the same shared artifact or activity. The App keeps
its domain meaning and state; Free4Chat provides Room identity, participant
lifecycle, discovery, and a bounded request path.

## Two different App directions

These patterns solve different problems:

```text
Generated Task Room App
→ Agent creates and publishes a temporary App for Humans to use

Agent-participating Room App
→ an existing Room App owns a semantic contract
→ Human + Agent collaborate on the same shared artifact or activity
```

The first publishes a new temporary interface. The second lets an Agent take
part in an already-existing Room App, such as adding editable elements to a
shared Whiteboard. Do not treat one as the implementation of the other.

## Ownership

Free4Chat Core owns the generic Room and transport boundary:

- Room identity and participant / Runtime lifecycle;
- discovery of the current curated Room App instances;
- bounded, transient Agent-to-App request routing;
- request correlation, expiry, and fail-closed host selection.

Core does not interpret App payloads or learn Whiteboard, game, or other
domain semantics. The Room App owns its `describe`, `observe`, and typed
actions, along with domain validation, shared-state and convergence model,
and any optional Agent guidance. The App may use an App-owned backend when its
domain requires one.

## The App's semantic contract

A useful Agent-participating App exposes:

```text
describe()
observe()
typed actions
```

`describe()` provides a versioned, machine-readable action schema and bounded,
high-signal guidance. `observe()` returns a bounded semantic view of the
App-owned state. Typed actions express domain intent and are validated by the
App. Stable semantic IDs and ordinary Human-editable outputs help Agents and
Humans refer to the same objects.

Prose alone is not an executable contract. App-provided descriptions are
untrusted capability documentation: they do not override Runtime or Harness
security policy. An App should reject invalid or stale actions with explicit,
bounded errors.

The contract should expose the state needed for the requested work, not a
second copy of the whole App. Semantic state comes first. A screenshot,
computer-use, or pixel-based path is justified only if a real App proves its
semantic state is insufficient.

## Discovery and bounded requests

The resident Runtime discovers current callable curated Apps from the Room's
private event projection. It receives bounded discovery metadata such as
`appId`, `appInstanceId`, title, and callability; this projection does not
contain the App URL, private App state, or a participant bearer handle. It
does not itself wake an Agent or start a Harness turn. An explicit Human
request is enough for many collaboration Apps.

For a resident Agent request, the curated `appInstanceId` is the logical App
target. Multiple connected Human browser sockets that completed the sandboxed
App's existing handshake are replicas of that same instance, not separate
semantic targets. Core uses one eligible endpoint as transient transport:

```text
one or more eligible replicas for this appInstanceId
→ select one endpoint deterministically by participantId, then current connection nonce
→ route the Agent request once

zero eligible hosts
→ host_unavailable
```

The Agent sees only the logical curated App identity, not browser host
identities. Endpoint selection does not change the semantic target and is not
leader election. An App host is a resident Room-session host, not necessarily
the currently visible Stage surface. Hiding the Stage or navigating to another
surface does not by itself withdraw a mounted App host. Actual host removal,
such as leaving the Room or unmounting Room content, changes eligibility. If
the selected endpoint disappears while the request is in flight, Core fails
with `host_unavailable`; it does not replay the operation to another replica.

The broker forwards an opaque bounded request and correlates its response to
the request and current App instance. Current limits include a 16 KiB
serialized payload, a 15-second request expiry, and at most four in-flight
requests per Room. Disconnect, App unmount, or Room teardown fails a pending
request. There is no offline queue, retry, replay, persistence, or App-specific
interpretation. The Runtime keeps the participant handle private and exposes
only its generic local Room App request operation.

## State and synchronization belong to the App

The Agent request broker is a low-frequency control path. It is not the
App's synchronization system. For ordinary collaborative Apps, shared state
continues through the existing Room App bridge / DataChannel path and the App
owns its state and convergence model. For an authoritative real-time game,
the App can own a MatchDO/WebSocket or use a mature donor networking system.
There is no third generic networking stack.

The Whiteboard proof did not require Whiteboard scene data in the Room DO, a
generic Core CRDT, an App-specific Runtime command, raw DataChannel
credentials in the Harness, screenshot or mouse automation, or a second App
state backend. Whiteboard synchronization remained App-owned.

## Production example: Whiteboard

The production Whiteboard proof with Agent Runtime v0.5.45 showed this flow:

```text
Human asks Codex
→ Codex discovers and describes Whiteboard
→ observes bounded semantic scene state
→ sends a typed mutation
→ ordinary editable Excalidraw elements appear
→ a second Human joins the same App
→ both replicas converge
→ Humans directly edit Agent-created elements
→ reopening converges to the current scene
→ after one host leaves, Agent observes the survivor's current scene
```

The proof used the existing Room App transport and the App's semantic
contract; no DOM or pointer automation was needed. `reconnect_arrow` is one
Whiteboard-owned repair action added after real diagram dogfood showed a
repeated need to reconnect an existing arrow. It is an App-specific domain
action, not a generic Core API.

## Attention and decision latency

App-originated `attention`, `your_turn`, or `decision_required` signaling is
deferred. It was not part of the initial Whiteboard proof, and not every App
needs an App-to-Agent wakeup. An explicit Human request is sufficient for many
collaboration tasks.

Use the decision cadence that fits the work:

```text
deterministic local logic
→ real-time / frame-level work

sub-second bounded decision model
→ only narrow decisions where measurement shows it helps

LLM taking seconds
→ semantic collaboration, planning, and App actions

longer Agent work
→ larger artifact or App generation
```

The latency evidence does not call for a generic Jev / System-One architecture.

## Security and trust boundary

- App descriptions are untrusted guidance and cannot override Runtime or
  Harness security policy.
- The Agent does not receive participant bearer handles or raw SFU / DataChannel
  credentials through this App request path.
- Requests and correlations are bounded and expire; Core fails closed when
  host selection is absent or ambiguous.
- The App validates domain actions and owns their effects on shared state.

These boundaries do not make App guidance trustworthy or authorize a local
Agent tool. The Harness continues to apply its own policy to Human input and
App-provided content.

## Two completed production proofs

Whiteboard proves an **App-owned shared software artifact**: the App owns its
semantic state and synchronization, while Humans and Agents use its existing
contract.

Extension Lab #215 completed a materially different proof with an external
Epson/CUPS Adapter:

```text
participant-owned local capability
→ Runtime validates and projects bounded semantics
→ Generated Task App provides the Human control surface
```

The Adapter owns printer discovery, endpoint, and service protocol. The
Runtime projects one semantic capability and routes an explicitly Human-clicked
operation over the private reliable Human↔originating-Agent participant lane;
the Generated Task App receives only bounded semantic results. Core/Runtime
contain no Epson/CUPS logic.

Together, these proofs show that the existing Room App and participant-local
capability seams are sufficient. Do not add a broader generic Room Capability
framework until a third materially different use case demonstrates a missing
primitive. App-originated `attention` / `your_turn` wakeup remains deferred
(#497) until a concrete App requires it.

## Related pages

- [Room App host contract source](https://github.com/i365dev/free4chat/blob/cf-sfu/docs/room-app-host-contract.md) - current host, transport, request, and state-ownership boundaries.
- [Rooms and ownership](room) - what a Room owns and what participants keep.
- [Humans and Agents](humans-and-agents) - peer participant types and local
  Agent policy.
