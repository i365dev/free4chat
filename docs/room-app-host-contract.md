# Room App host and transport contract

This is an internal description of the current bounded Room App host boundary.
It is not a public SDK, marketplace, or arbitrary iframe registration API.

> **Free4Chat provides a temporary Room boundary and bounded transport. Each
> Room App owns its domain state, rules, convergence model, and optional
> persistence.**

## Bootstrap and sandbox

The host renders curated App definitions accepted from the Lab-owned catalog,
under the core-pinned production origin `https://room-apps.free4.chat`. Local
development uses an explicit development origin and does not change production
allowlisting. A Task-authorized Agent may also publish one bounded generated
App for its Task; that App is a Room-owned `srcDoc` bundle, not a catalog entry
or a general hosting URL.

The iframe uses `sandbox="allow-scripts"` only. It receives no
`allow-same-origin`, Room cookies/history, participant or SFU credentials,
provider credentials, filesystem access, microphone/camera permission,
PeerConnection, or raw DataChannel. A curated App may receive the narrowly
delegated `clipboard-write` permission only when its validated Lab catalog
entry opts in. This permits browser clipboard writes subject to browser policy
and the browser's user-gesture requirements. `clipboard-read` remains
unavailable, and the opaque-origin sandbox is unchanged.

Generated Task Apps receive no iframe permission delegation, including
`clipboard-write`, even if their source attempts to use the Clipboard API.
Generated Apps use the same host and MessagePort boundary, plus a strict
inline-only CSP (`connect-src 'none'`, `img-src data:`). V0 accepts only
`html`, `css`, and `js` source with an empty `networkOrigins` list. The bundle
is at most 48 KiB, initial/shared state at most 16 KiB, and one Room may hold at
most four generated Apps. Direct App network access is not part of V0; a
generic network runtime would need a separate authorization and proxy design.
Generated Task Apps can invoke bounded semantic capabilities through the
host-owned MessagePort bridge. The Room projects a temporary association from
the published App and originating Task to its current Agent, Runtime Host, and
available capability IDs. That sparse association is control-plane state; it
does not carry operation requests or results. App code cannot choose a Runtime
Host or make network requests.

The Lab catalog's optional `clipboardWrite: true` field is the only current
clipboard opt-in. Missing metadata grants nothing; unsupported capability
fields or values fail catalog validation. Roll out Core support first, deploy
it, and only then add the field to the Lab catalog. Older deployed Core parsers
reject unknown catalog keys, so the Lab catalog must remain unchanged until
Core is deployed.

On iframe load, the host sends a bootstrap `postMessage` with a dedicated
`MessagePort`, bounded `appInstanceId`, and one-time handshake token. The App
answers `ready` on that port with the token. The host then sends only the
bounded `self`, `participants`, and current App instance projection.

Generated Apps additionally receive the current shared-state object and
revision. `shared.set(next)` is an optimistic revisioned update through the
authenticated Room WebSocket; the Room rejects stale revisions and broadcasts
the committed state. The state is ephemeral Room storage and is deleted with
the Room.

Generated App code may call `free4chat.capabilities.observe(capabilityId)` or
`free4chat.capabilities.invoke(capabilityId, action, args)` from the trusted
click handler for a concrete control (`button`, form control, link, or
`role="button"`). The bridge consumes exactly one operation for that click.
The click authorization remains active through the click event's handlers and
microtasks, then expires; mount-time and ambient calls are refused.

The parent host sends the bounded request over its existing reliable Room App
DataChannel. The originating Runtime subscribes to that Human's reliable lane
on its no-media Pion participant session, validates the current association,
and invokes its local capability controller. The result returns on the same
reliable lane. RoomSession handles association, channel admission, and
readiness only; it never relays per-operation payloads. Runtime or Adapter
departure makes the route unavailable, and disconnected operations are neither
queued nor replayed. Task completion alone does not invalidate a still-live
originating route. Results use the semantic result bounds, which exclude
endpoint, credential, URI, hostname, and protocol details. The iframe receives
no Host ID, participant capability, session ID, or Runtime connection details.

## Messages and trust boundary

The App may request:

```text
sendReliable(payload)
sendRealtime(payload)
sendReliableTo({ requestId, targetParticipantId, payload })
```

The host validates the current Room/App instance, message shape, serialized
UTF-8 size, and rate budget before sending. Inbound messages delivered to an
App carry a host-derived `sourceParticipantId`; an App payload cannot set or
override that identity.

Broadcast messages use the existing authenticated Human PeerConnection and
Cloudflare Realtime SFU DataChannels. One named channel per lane is shared by
the Room App instances; `appInstanceId` multiplexes bounded messages:

- `reliable`: ordered, fully reliable DataChannel;
- `realtime`: unordered and stale-droppable (`maxRetransmits: 0`).

Generated capability request and result frames use only the reliable lane.
The public App send primitive rejects those reserved frame types; only the
host-owned capability bridge can emit them. The Runtime subscribes only to
currently ready Human reliable channels and publishes results on its
`room-app-reliable-{participantId}` lane.

Participant-targeted reliable messages use the existing authenticated Room
WebSocket as a separate low-frequency path. The Room derives sender identity
from the socket attachment, verifies the current App instance and connected
Human target, and sends only to that target's authenticated browser socket.
The Room validates App identity against the Lab runtime catalog through an
internal Worker Service Binding; browsers load the same bounded catalog from
the fixed public catalog route.
The recipient receives a server-derived `sourceParticipantId`; the sender
receives a bounded correlated result. Unicast is ephemeral: it is not broadcast,
queued for offline participants, or stored in Room state, message history,
Agent event streams, analytics, or logs. It is not end-to-end encrypted because
the Room server relays the payload.

## Resident Agent request relay

An explicitly invoked resident Runtime request may use the generic MCP tool
`room_app_request(appInstanceId, payload)`. The Room accepts only a current
Agent participant handle and a curated Room App instance in the current Room.
An eligible host is a connected Human browser socket whose sandboxed curated
iframe has completed the existing MessagePort handshake and whose socket
attachment still names that App instance. The Room routes only when exactly
one eligible host exists; zero hosts or multiple hosts fail immediately.

The host forwards the opaque JSON request and correlated `requestId` through
the existing iframe MessagePort. A response must return on the same
authenticated host socket, name the exact current App instance and request id,
and fit the same 16 KiB serialized UTF-8 bound. Requests expire after 15
seconds, at most four may be in flight per Room, and host/Agent disconnect,
App unmount, or Room teardown fails the request. Unknown, duplicate, and late
responses are ignored. No offline queue, retry, replay, persistence, Room
history, analytics content, arbitrary URL proxy, or App-specific interpretation
is provided. The Runtime keeps the participant handle private and exposes only
the generic local `room-app request` operation.

## Resident Agent discovery projection

The existing private resident `events` envelope includes a bounded `roomApps`
array alongside the current participant and Runtime Host projections. Each
entry contains only `appInstanceId`, `appId`, the Lab catalog label as `title`,
`source: "curated"`, and whether the instance is currently callable. An
instance appears only while a connected Human socket is current and its
sandboxed iframe has completed the existing ready handshake. Generated Task
Apps are not included in this Room-scoped projection.

An instance with exactly one eligible host is marked callable. If more than
one connected Human hosts the same instance, it is included with
`callable: false` and `unavailableReason: "ambiguous_host"`; the Runtime must
not guess which host to use. Stale, invalid, or unallowlisted metadata is
omitted. The projection contains no App URL, token, socket identity, or private
App state. It is refreshed with the existing Room event projection and does
not itself wake an Agent or create a Harness turn; the next Human event carries
the current snapshot into that turn.

The projection is discovery metadata only. Core and Runtime do not interpret
App-specific request payloads or define App operations. An Agent uses the
existing opaque `room_app_request` path only when the Human request and App
identity are clear; ambiguity or absence requires clarification. `$App` as a
structured Human message reference remains a separate follow-up because it
requires changes to composer selection state and Room/Task message contracts.

Free4Chat does not interpret App payloads or define App operation semantics.
Reliable delivery is not an operation log or replay service; realtime delivery
does not guarantee intermediate updates arrive. Apps own bootstrap,
reconnect/convergence, duplicate/stale handling, and recovery semantics.

## Current bounds

- serialized UTF-8 payload: at most 16 KiB;
- reliable broadcast: at most 20 messages/sec;
- realtime broadcast: at most 60 messages/sec;
- combined broadcast: at most 256 KiB/sec;
- reliable unicast: at most 10 messages/sec and 64 KiB/sec per sender;
- resident App hosts: at most 2 per browser Room session.
- generated bundle: at most 48 KiB per Task App, four Apps per Room;
- generated state: at most 16 KiB per snapshot and 4 KiB per update.

The host keeps only coarse in-memory transport counters. App message payloads do
not enter Room messages, history, analytics, or Durable Object storage; the
bounded Generated Task Room App bundle and shared state below are the
deliberate exception.

## Stage and lifecycle

Room App visibility is independent from the Room/Task conversation. A curated
App is created lazily when selected; once mounted, its iframe and MessagePort
remain resident for the browser Room session. Hiding or switching the Stage is
presentation only and does not reset the App. Hidden Apps remain non-interactive
while receiving bounded host messages.

Resident hosts survive ordinary transport reconnects while DataChannels are
rebuilt. They are removed when Room content unmounts, their catalog definition
is no longer valid, or Room Apps are disabled. App-specific reset semantics
remain App-owned.

An unavailable or malformed App must not make ordinary Room chat, voice, Tasks,
attachments, or screen sharing unavailable.

## State ownership

Free4Chat owns Room lifecycle, participant presence, App identity, sandbox
host, bounded participant projection, transport, lifecycle, coarse host-owned
lifecycle analytics, and security/rate limits. The App owns rendering, domain
rules, operation/state model, convergence, simulation/authority model, reset
semantics, and any persistence or backend.

The Room does not provide an App-domain database, event log, snapshot service,
or periodic App-state backup. Apps that keep only browser replicas may restart
empty after every active replica disappears. That is an App-level durability
choice, not a reason to make the Room understand domain payloads.

Generated Task Room Apps are the bounded exception to participant-owned App
state: the Room stores their bundle chunks and one current state snapshot so
late Room participants can load the same Task App. One Task has at most one
publication: an identical retry is a duplicate, while a changed valid bundle
keeps the same `appInstanceId` and increments `bundleRevision` without resetting
shared state. This is still temporary Room
state that disappears with the Room, not a durable application backend, and the
publishing Agent must be the current authority for the correlated Task.
