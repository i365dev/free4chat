---
name: free4chat-agent-media
description: free4chat Agent media plane (Pion sidecar) architecture quick reference and staged debugging discipline — multi-MID attribution, stdio protocol, signaling direction self-inspection, lazy OnTrack, daemon/env traps. Use when debugging Meeting Notes audio, image/text attachments, unresponsive agents, or non-flowing RTP.
---

# free4Chat Agent media plane quick reference (#100 Phase 2 proven shape)

Deep docs: `experiments/pion-cloudflare/ARCHITECTURE.md`; normative: issue
#100; debugging methodology: issue #101. This skill is the 60-second
pre-work refresher plus the high-frequency trap list.

## Architecture in one diagram

```
Human browsers ──WebRTC──> Cloudflare SFU <──Pion(Go child)── Node agent-runtime
                                                          │ stdio JSON lines
                                    MeetingNotesController(grant) → per-MID Opus frames
                                    → Opus→PCM → Doubao STT → local transcript
                                    → Hermes Harness(@tag wakeup, with notes)
```

- **Node owns all communication**: MCP join/heartbeat/grant polling, every
  `/api/sfu/*` call, credentials. Go only exchanges SDP strings and RTP
  stats — zero HTTP, zero secrets (issue #100 §14 boundary).
- Engine selection: `FREE4CHAT_MEDIA_ENGINE=pion` + `FREE4CHAT_PION_BIN=…`;
  default stays werift.
- Text attachments: `read_attachment` returns a JSON envelope
  `{attachment,data,text}` for text/* files; the runtime inlines them as
  `event.textFile` (32K char cap). Images ride MCP ImageContent.

## Staged verification discipline (#101 — follow on every investigation)

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
  assignment-based; late registration loses events — this caused "ontrack
  never fires + bridge re-subscribes every 10s" in a real session).

## Signaling direction: always branch on the actual type (#101 §4)

- Production `agent-session` uses the native initial-offer contract: the
  request carries `sessionDescription{offer}` and the response is the answer.
- cf-sfu HEAD variant: blank session + `datachannels/establish` (offer may be
  attached, or the server offers first). Support both adaptively.
- `tracks/new` always returns a **server OFFER** + mid ⇒ setRemote(offer),
  assert have-remote-offer, createAnswer, setLocal, PUT renegotiate.
  `requiresImmediateRenegotiation` is telemetry only, never a substitute for
  inspecting the returned description type.

## Multi-participant attribution

- Each human publishes an independent track; the SFU forwards tracks
  separately and Pion keeps one receiver per MID ⇒ simultaneous speech does
  not cross-contaminate (verified live). Bind by exact equality between the
  tracks/new mid and transceiver.mid — never by callback order.
- Degradation happens only when one microphone picks up two voices
  (acoustics, not architecture).

## Stop semantics

Stop makes the server immediately close the agent's subscribed mids (both
streams EOF'd simultaneously in a verified run) ⇒ transcript freezes at once.
Never assume client-side soft-stop.

## High-frequency environment traps

| Symptom | Root cause |
| --- | --- |
| Daemon ignores changed env | The daemon process persists env from first spawn → kill it, join again |
| Every MCP call -32022 | Hit the modern-only deployed stack: `_meta` envelope + `Mcp-Method/Mcp-Name` headers required, no initialize handshake (use ModernMcpFree4ChatClient) |
| @tag gets no reply | addressed=false: targets are injected by the browser UI; curl/agent-sent text cannot address anyone (by design) |
| Image unreadable, model claims "500" | Check attachment-errors log first; models embellish unavailable-image notes with plausible status codes |
| Browser cannot join under wrangler dev | Origin allow-list only has localhost:3000; Turnstile via build-time `NEXT_PUBLIC_TURNSTILE_DISABLED=1` |

## Test/build commands (two systems — do not mix)

```bash
cd agent-runtime && npm test          # tsx --test (node:test style), authoritative gate
cd app         && npm run type-check && npm test   # vitest
go vet ./... && go test ./...        # experiments/pion-cloudflare
```
