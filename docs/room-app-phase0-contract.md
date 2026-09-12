# Room App Phase 0 internal contract

This document records the current internal Room App seam proven by the Phase 0
Lab fixtures and production dogfood. It is not a public SDK, extension API, or
registry commitment.

The canonical product boundary is:

> **Free4Chat provides the temporary Room boundary and bounded transport. The
> Room App owns its domain state, convergence model, and optional persistence.**

A Room App may use the Free4Chat transport as its only realtime path, combine it
with its own backend, or use its own CRDT/simulation/state system. Free4Chat does
not interpret App domain payloads.

## Bootstrap and sandbox

The Room renders only curated App definitions in sandboxed iframes:

- production origin: `https://room-apps.free4.chat`;
- local development origin: `http://localhost:8787`;
- sandbox: `allow-scripts` only;
- no `allow-same-origin`, camera, microphone, cookies, Room history, SFU
  credentials, participant tokens, Agent credentials, PeerConnection, or raw
  DataChannel is passed to the App.

On iframe load, the host sends a bootstrap `postMessage` carrying one dedicated
`MessagePort`, a bounded `appInstanceId`, and a one-time handshake token. The
App answers on that port with `ready` and the token. The host then sends only the
bounded `self` and `participants` projection.

The participant projection may contain both Humans and Agents. Free4Chat does
not impose domain semantics on participant kind. A Canvas may treat both as
participants; a game may choose to give player slots only to Humans; a future
App may expose a separate semantic Agent interface. That decision belongs to
the App, not the Room core.

## Messages and trust boundary

The iframe may request:

```text
sendReliable(payload)
sendRealtime(payload)
```

The host validates the current curated Room instance, payload shape, serialized
UTF-8 size, and local rate budget before sending. Messages delivered from the
host to the App carry a host-derived `sourceParticipantId`; App payloads cannot
set or override that identity.

Conceptually the seam is intentionally close to a small socket abstraction:

```text
App operation / state update
        ↓
Free4Chat reliable or realtime lane
        ↓
other participant's instance of the same App
```

Free4Chat does not know whether a payload is a stroke, CRDT update, transform,
card move, chess action, document edit, game command, or something else.

Join/leave notifications are generated from the current Room participant
projection. The App cannot choose arbitrary relay destinations and receives no
Room message history or private participant context.

## Transport

Free4Chat reuses the existing Human PeerConnection and Cloudflare Realtime SFU
DataChannel substrate. Each Human publishes one named channel per lane; the
`appInstanceId` multiplexes bounded App messages over those channels.

- `reliable`: ordered, fully reliable DataChannel;
- `realtime`: unordered, `maxRetransmits: 0`, deliberately stale-droppable;
- no Durable Object message/history/storage write is created for normal App
  traffic;
- no PeerConnection is created per App;
- the host keeps coarse in-memory counters for messages, bytes, and drops only.

The choice of DataChannel is an implementation/economic fit, not a requirement
that App state be WebRTC-specific. An equivalent App could use its own WebSocket
or other backend. The value of the Free4Chat seam is that a Room already has a
participant-aware realtime substrate, so a simple App does not need a second
realtime service merely to exchange bounded messages.

Transport delivery and state convergence are different responsibilities.
`reliable` means the underlying established DataChannel is reliable; it does
not turn Free4Chat into an App operation log, replay system, CRDT provider, or
persistent state service. App code must still handle its own bootstrap,
reconnect/convergence, duplicate/stale operations, and any recovery semantics it
requires.

## Stage and browser-session lifecycle

Room App visibility is independent from conversation scope:

```text
Conversation
├─ Room
└─ Task

Visual Stage
├─ participants / idle
├─ Screen Share
├─ Task Live View
└─ Room App
```

Opening a Room App does not replace Room/Task conversation.

A curated App is lazily launched on first use. Once launched, its
`RoomAppHost`, iframe, and MessagePort remain resident for the current browser
Room session. Stage navigation is presentation only:

```text
Canvas → Arena
App → Screen Share
App → Task Live View
Close
```

hide the App but do not reset or destroy its session. Re-selecting the App reuses
the same iframe and MessagePort. Hidden Apps are `display: none`, `inert`, and
`aria-hidden`, so they remain non-interactive while still receiving their
bounded App messages.

Resident hosts also survive an ordinary transport reconnect while the Room App
DataChannels are rebuilt. They are destroyed only when the Room content itself
unmounts, the curated entry truly disappears, or Room Apps become stably
disabled. App-specific reset semantics remain App-owned (`Clear canvas`, future
`Restart` / `New round`, and so on).

Current bounds remain:

- payload: at most 16 KiB serialized UTF-8;
- reliable: at most 20 messages/sec;
- realtime: at most 60 messages/sec;
- combined transport budget: at most 256 KiB/sec;
- Phase 0 curated catalog: at most two resident Apps per browser Room session.

## State ownership and persistence

Free4Chat does **not** own Room App domain state.

```text
Free4Chat core
├─ Room lifecycle / participant presence
├─ curated App identity + sandbox host
├─ bounded participant projection
├─ reliable / realtime transport
├─ browser-session App host lifecycle
└─ security / rate / cost limits

Room App
├─ rendering
├─ domain rules
├─ operation/state model
├─ convergence / anti-entropy / CRDT if needed
├─ simulation / authority model if needed
├─ reset semantics
└─ optional persistence / backend / App-owned DO or database
```

There is intentionally no generic Free4Chat App-state database, snapshot log,
or periodic Durable Object backup in Phase 0. If every browser replica is lost
(for example all participants refresh), an App with only in-browser replicas may
restart empty. That is an acceptable Phase 0 limitation, not a reason to make
the Room DO understand every App's state.

If a future production App needs durability, it should normally own that
persistence boundary itself. A Whiteboard could use a CRDT provider and its own
snapshot backend; a game could use an authoritative server/DO; another App may
remain entirely ephemeral. Free4Chat should not couple these domain choices into
the Room protocol.

## What the two Phase 0 fixtures actually prove

### Shared Canvas

Shared Canvas is **not a CRDT** today. It uses small App-owned replicated
operations plus bounded bootstrap state:

```text
local stroke
→ apply locally
→ reliable stroke operation
→ remote replica applies operation

new replica
→ bootstrap_request
→ deterministic incumbent returns bounded canonical snapshot
→ newcomer merges snapshot
```

It also owns stroke ids, generation/epoch handling, duplicate/stale rejection,
compaction, clear semantics, and canonical bootstrap. None of those concepts
exist in Free4Chat core.

Production dogfood exposed a remaining Canvas-local convergence gap: on some
runs, one or two very early strokes were permanently absent on another client,
while later strokes synchronized normally; repeating after refresh could pass.
One plausible window is that a local publisher is already usable while a remote
participant's App DataChannel subscription is still establishing. The current
Canvas requests bootstrap only on initial App `ready` and has no retry/digest
anti-entropy loop, so a missed early operation can remain divergent.

Treat this as an **App-level convergence problem**, not evidence that Free4Chat
should persist Canvas state. The narrow follow-up is Canvas-local bounded
reconciliation/anti-entropy (for example bootstrap retry and/or a low-frequency
state digest), without adding a Room App operation log or generic persistence to
Free4Chat.

### Tiny Arena

Tiny Arena is also **not a CRDT**. It uses App-owned transient state
replication:

```text
local movement
→ realtime transform
→ remote target update
→ interpolation
```

Arena owns entity mapping, epochs/sequences, stale rejection, interpolation,
and bounded transform sending. Lost intermediate realtime transforms are
expected and later transforms normally supersede them. A stationary entity can
still expose a convergence gap if its current transform was missed and no later
movement causes a reannounce; that remains an Arena-local synchronization
concern.

The different behavior of Canvas and Arena is useful evidence for the boundary:
Free4Chat provides message transport; each App decides what "eventually
consistent" means for its own state model.

## Phase 0 interpretation

Production dogfood has so far validated:

- curated sandbox deployment and handshake;
- one generic host/bridge used by materially different Apps;
- Stage placement while Room/Task conversation remains usable;
- resident App sessions across Stage switches, visual Close/Hide, and ordinary
  transport reconnects;
- coexistence with Room text, voice, attachments, Screen Share, Tasks, and Task
  Live View;
- no App domain logic in Room core;
- no App traffic DO/history hot path;
- no per-App PeerConnection.

The remaining convergence findings should be fixed, when necessary, at the App
layer. They do not change the architectural ownership boundary and should not
be used to justify a generic Room App state store, public SDK, registry,
marketplace, or persistence framework.
