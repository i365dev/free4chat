---
name: free4chat-agent-media
description: free4chat Agent media plane (Go runtime, in-process Pion) architecture quick reference and staged debugging discipline — multi-MID attribution, signaling direction self-inspection, lazy OnTrack, daemon/env traps. Use when debugging Meeting Notes audio, Voice Reply, image/text attachments, unresponsive agents, or non-flowing RTP.
---

# free4Chat Agent media plane quick reference (Go runtime, in-process Pion)

Canonical runtime: `agent/` (self-contained Go binary). Media:
`agent/internal/media/` — `media.Controller` + `media.Bridge` with Pion
compiled into the same executable. There is no child process, no sidecar
engine bridge, no separately provisioned engine binary.

## Architecture in one diagram

```
Human browsers ──WebRTC──> Cloudflare SFU <──in-process Pion── free4chat-agent (Go)
                                                                 │ resident daemon
                                  media.Controller (meetingNotes grant)
                                  → per-MID Opus frames → Doubao STT → transcript
                                  → Voice Reply: TTS PCM → Opus → publish
```

- **The Go runtime owns all communication**: MCP join/heartbeat/grant polling,
  every `/api/sfu/*` call, and credentials. Pion is in the same binary.
- **ONE shared media session** serves both Meeting Notes (Human audio ingress)
  and Voice Reply (Agent audio egress); bootstrap is receive-only and the
  outbound track is armed only at voice-grant activation.
- The meetingNotes grant is room state owned by `RoomSession`: every Agent
  media operation re-checks the current grant, and Stop is a server-side
  track close (`do/realtimeMedia.ts`), never a UI toggle.
- Text attachments: `read_attachment` returns a JSON envelope
  `{attachment,data,text}` for text/* files; the runtime inlines them as
  `event.textFile`. Images ride MCP ImageContent.

## Staged verification discipline (follow on every investigation)

```
A PC+server-events DC → B offer+full ICE gather → C authorized session creation
→ D remote description applied by ACTUAL type → E PeerConnectionStateConnected
→ F discover & select exactly one live human track → G tracks/new (inspect type!)
→ H OnTrack metadata → I ReadRTP count > 0
```

- Stop at the first failing stage; investigate only that stage.
- REST 200 ≠ media. OnTrack ≠ RTP.
- **Pion OnTrack is lazy**: it fires only when SRTP packets arrive. Fully
  successful signaling with nobody speaking = no OnTrack, not a bug.
- **pc.OnTrack handler must be registered at PC creation** (Pion semantics are
  assignment-based; late registration loses events).

## Signaling direction: always branch on the actual type

- Production `agent-session` uses the native initial-offer contract: the
  request carries `sessionDescription{offer}` and the response is the answer.
- `tracks/new` always returns a **server OFFER** + mid ⇒ setRemote(offer),
  assert have-remote-offer, createAnswer, setLocal, PUT renegotiate.
  `requiresImmediateRenegotiation` is telemetry only, never a substitute for
  inspecting the returned description type.

## Multi-participant attribution

- Each human publishes an independent track; the SFU forwards tracks
  separately and Pion keeps one receiver per MID ⇒ simultaneous speech does
  not cross-contaminate. Bind by exact equality between the tracks/new mid
  and transceiver.mid — never by callback order.

## Stop semantics

Stop makes the server immediately close the agent's subscribed mids ⇒
transcript freezes at once. Never assume client-side soft-stop.

## High-frequency environment traps

| Symptom | Root cause |
| --- | --- |
| Daemon ignores changed env | The resident daemon keeps the environment from first spawn → restart it, join again |
| @tag gets no reply | addressed=false: targets are injected by the browser UI; curl/agent-sent text cannot address anyone (by design) |
| Image unreadable, model claims "500" | Check the runtime's attachment-error log first; models embellish unavailable-image notes with plausible status codes |
| Browser cannot join under wrangler dev | Origin allow-list only has localhost:3000; Turnstile via build-time `NEXT_PUBLIC_TURNSTILE_DISABLED=1` |

## Test/build commands (canonical Go runtime)

```bash
cd agent && go test ./... -count=1 -timeout 300s   # Go runtime tests, authoritative gate
cd app   && npm run type-check && npm test          # Worker/DO vitest
```

The frozen Node runtime tag `node-agent-runtime-e2e-2026-08-27` / branch
`archive/node-agent-runtime` document the pre-Go sidecar architecture; they
are historical references, not a supported runtime path.
