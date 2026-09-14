# Room App host and transport contract

This is an internal description of the current bounded Room App host boundary.
It is not a public SDK, marketplace, or arbitrary iframe registration API.

> **Free4Chat provides a temporary Room boundary and bounded transport. Each
> Room App owns its domain state, rules, convergence model, and optional
> persistence.**

## Bootstrap and sandbox

The host renders only App definitions accepted from the Lab-owned catalog,
under the core-pinned production origin `https://room-apps.free4.chat`. Local
development uses an explicit development origin and does not change production
allowlisting.

The iframe uses `sandbox="allow-scripts"` only. It receives no
`allow-same-origin`, Room cookies/history, participant or SFU credentials,
provider credentials, filesystem access, microphone/camera permission,
PeerConnection, or raw DataChannel.

On iframe load, the host sends a bootstrap `postMessage` with a dedicated
`MessagePort`, bounded `appInstanceId`, and one-time handshake token. The App
answers `ready` on that port with the token. The host then sends only the
bounded `self`, `participants`, and current App instance projection.

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

The host keeps only coarse in-memory transport counters. App payloads do not
enter Room messages, history, analytics, or Durable Object storage.

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
host, bounded participant projection, transport, lifecycle, and security/rate
limits. The App owns rendering, domain rules, operation/state model, convergence,
simulation/authority model, reset semantics, and any persistence or backend.

The Room does not provide an App-domain database, event log, snapshot service,
or periodic App-state backup. Apps that keep only browser replicas may restart
empty after every active replica disappears. That is an App-level durability
choice, not a reason to make the Room understand domain payloads.
