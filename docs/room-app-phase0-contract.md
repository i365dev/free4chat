# Room App Phase 0 internal contract

This is an experimental Lab-facing seam, not a public SDK or extension
registry. The Room App catalog is compiled into Free4Chat and is disabled by
the `ROOM_APPS_ENABLED` Worker flag until the fixture deployment is ready.

## Bootstrap

The Room renders only a curated App definition in a sandboxed iframe:

- production origin: `https://room-apps.free4.chat`;
- local development origin: `http://localhost:8787`;
- sandbox: `allow-scripts` only;
- no `allow-same-origin`, camera, microphone, cookies, Room history, SFU
  credentials, participant tokens, Agent credentials, PeerConnection, or raw
  DataChannel is passed to the App.

On iframe load, the host sends a bootstrap `postMessage` carrying one
dedicated `MessagePort`, a bounded `appInstanceId`, and a one-time handshake
token. The App must answer on that port with `ready` and the token. The host
then sends only the bounded `self` and `participants` projection.

## Messages

All transport messages contain:

```text
protocolVersion
appInstanceId
lane: reliable | realtime
payload: bounded JSON object
```

Messages delivered from the host to the App also contain the host-derived
`sourceParticipantId`. It is bound to the remote SFU channel owner; an App
payload cannot set or override it, and payloads using that reserved field are
rejected.

The iframe may request `sendReliable` or `sendRealtime`. The host validates
the current curated Room instance, payload shape, UTF-8 size, and local rate
budget before sending. Unknown instances are rejected before rate accounting
or listener dispatch. Join/leave notifications are host-generated from the
current Room participant projection. The App cannot choose a relay
destination.

The App receives no Room message ring or persistent App state. A closed or
failed iframe only removes its MessagePort; ordinary Room chat, media, Tasks,
attachments, and Live View remain independent.

## Transport

Free4Chat reuses the existing Human PeerConnection and Cloudflare Realtime
SFU DataChannel substrate. Each Human publishes one named channel per lane;
the `appInstanceId` multiplexes the bounded App messages over those channels.

- reliable lane: ordered, fully reliable DataChannel;
- realtime lane: unordered, `maxRetransmits: 0` DataChannel;
- no Durable Object message/storage write is created for App traffic;
- no PeerConnection is created per App.

The realtime lane is therefore genuinely stale-droppable for this fixture.
The host keeps coarse in-memory counters for messages, bytes, and drops only.

## Bounds and lifecycle

- payload: at most 16 KiB serialized UTF-8;
- reliable: at most 20 messages/sec;
- realtime: at most 60 messages/sec;
- combined transport budget: at most 256 KiB/sec;
- at most two App tabs are admitted by the Phase 0 UI (one is mounted at a
  time in the current Room shell).

App instances are browser/Room scoped and deterministic for the curated App
id. There is no Room persistence, history, alarm, or recovery protocol. Room
participant changes update the projection; closing/unmounting the App closes
the port and leaves the Room untouched.
