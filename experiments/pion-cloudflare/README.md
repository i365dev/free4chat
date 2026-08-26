# experiments/pion-cloudflare — Pion media engine (issue #100)

Status: **Phase 1 proven** (ReadRTP > 0 against a live browser mic) and
**Phase 2 integrated**: this directory now contains the Go media-engine child
process used by `agent-runtime` when `FREE4CHAT_MEDIA_ENGINE=pion`, plus the
Node driver used for staged live validation.

## Layout

| File | Role |
| --- | --- |
| `main.go` | stdio JSON command loop (`init` / `create-offer` / `apply-remote` / `arm-track` / `wait-connected` / `rtp-stats` / `close`) |
| `media.go` | pure media engine: PeerConnection, ICE gathering, type-inspecting apply, per-MID RTP forwarding, OnTrack metadata, nominated-pair stats |
| `trace.go` | stderr stage tracer + dump dir (full SDP, ICE candidates, HTTP traces, per-mid RTP headers, raw Opus) |
| `driver.mjs` | Node orchestrator for standalone live runs: MCP join/grant-wait/heartbeat + all `/api/sfu/*` calls + spawns the Go child; prints `RESULT PASS/FAIL last_stage=…` |

The Go binary performs zero HTTP and holds zero credentials. Node owns every
Free4Chat call and the participant handle (#100 §14 boundary). The runtime's
production entry point is NOT this driver — it is
`agent-runtime/src/media/pionPeerConnectionLike.ts`, which adapts the same
child process to the existing `PeerConnectionLike` abstraction.

## Live run (standalone driver)

```bash
cd experiments/pion-cloudflare
go build .
node driver.mjs --room <room-id> --name "Pion Spike" \
  [--base-url https://www.free4.chat] [--target "<human name>"] \
  [--mode client-offer|server-offer] [--listen-seconds 12]
```

Then in a real browser: open the room, enable the microphone, click
**Start Meeting Notes**, select this agent as note-taker, and speak.
Success ends with:

```
RESULT PASS rtp_packets=N codec=audio/opus/48000/2 … mid=…
```

Diagnostics land in `/tmp/free4chat-pion/run-<ts>/` (SDP, HTTP bodies, ICE,
RTP headers, raw Opus). Never commit them.

## Runtime integration

```bash
cd agent-runtime
npm run build
FREE4CHAT_MEDIA_ENGINE=pion \
FREE4CHAT_PION_BIN=$(pwd)/../experiments/pion-cloudflare/pion-cloudflare \
node dist/cli.js join --room <room-id> --agent hermes --name "Pion Spike"
```

## Tests

Deterministic tests only (description-type guard, stdio shapes, enrichment).
Per #100 §17 no mock pretends to prove ICE/Cloudflare/RTP interop — the live
run above is the proof.

See `ARCHITECTURE.md` for the extension map (recording, voiceReply TTS,
realtime voice) and `.agent/skills/free4chat-agent-media` for the debugging
discipline.
