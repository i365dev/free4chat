# Architecture: Pion media plane and its extensions

Status: Phase 2 E2E-proven on branch `experiment/pion-cloudflare` (2026-08-24).
Normative context: issue #100 (architecture), issue #101 (debug runbook).

## Proven baseline

```
Human browsers ──WebRTC──> Cloudflare Realtime SFU <──Pion(Go child)── Node agent-runtime
   (mic)                       (grant-guarded)            │ stdio JSON lines
                                                          ▼
        MeetingNotesController (grant lifecycle, unchanged Worker/DO contract)
        → PionPeerConnectionLike adapter (pionPeerConnectionLike.ts)
        → per-participant Opus frames (mid-bound, ev:rtp base64 events)
        → existing Opus→PCM decoder → Doubao streaming STT
        → attributed local transcript (.meeting-notes/transcript.jsonl)
        → Hermes Harness wakeup with meetingTranscript → answered @tag Q&A
```

E2E evidence: 2 humans live, both mids OnTrack'd, Dw-attributed committed
segments, addressed question answered from notes, Stop produced server-side
track close (both streams EOF'd) and a frozen transcript.

Engine selection: `FREE4CHAT_MEDIA_ENGINE=pion` (+ `FREE4CHAT_PION_BIN`);
default remains werift so production behavior is opt-in.

## Extension 1 — Meeting recording (small, natural)

The per-participant Opus streams already terminate in Node. Recording is a
tee on that boundary:

```
ev:rtp ──┬→ decoder → Doubao → transcript   (existing)
         └→ file sink (per participant .ogg/.opus, local disk only)
```

Constraints (non-negotiable): explicit room-visible opt-in (a `recording`
grant mirroring meetingNotes), local-disk only, never Worker/KV/R2/cloud,
bounded retention, surfaced in UI while active. No new transport work.

## Extension 2 — Agent TTS voice in room (voiceReply grant)

Today agents are subscribe-only by invariant (Worker rejects
`location:"local"` for agent sessions; DO double-checks). Outbound voice is
therefore a **grant + policy change first, transport second**:

1. New room-visible `voiceReply` grant (mirrors meetingNotes lifecycle,
   human-initiated, revocable, server-side close semantics).
2. Worker: allow `location:"local"` publish ONLY under an active voiceReply
   grant for the named agent (keep current rejection otherwise).
3. Pion engine gains ops: add-publish-track(codec), write-rtp(payload),
   plus outbound SSRC/payload-type management.
4. TTS text→Opus stays in Node (provider-agnostic); frames cross the same
   stdio IPC as ingress.

Sequencing per #100: separate RFC/PR series AFTER Meeting Notes is stable.
Do not relax the subscribe-only invariant incrementally or implicitly.

## Extension 3 — Doubao realtime voice (full duplex)

Recommended shape keeps Cloudflare as the ONLY room-audible transport:

```
Doubao realtime WS (in Node) → TTS frames → Pion publish track → SFU → room
room audio (Pion) → STT path → barge-in/VAD signals → Doubao session control
```

Anti-pattern to avoid: piping agent audio directly browser↔Doubao outside
the SFU — it bypasses the room-visible authorization model and the
server-side close guarantee. Barge-in needs VAD + deterministic cancellation
(#100 Phase 4 scope).

## Proven extension: text-like attachments (#82/#90 follow-up)

`read_attachment` now serves two attachment classes behind the same chunked
ephemeral store:

- images (jpeg/png/webp) → MCP ImageContent (vision path, verified);
- text/plain / text/markdown / text/csv / application/json → decoded UTF-8
  `text` inside the standard JSON envelope, inlined by the runtime as
  `event.textFile` (32K char cap) and rendered to the Harness between
  FILE_CONTENT markers.

Gates widened at all three layers (upload endpoint, DO validAttachment +
handleAttachmentUpload, MCP branch). PDFs should be extracted runtime-side
(BYOK principle); binaries stay invisible by design.

## Operational notes learned during E2E

- Prod `/mcp` speaks modern-only MCP (2026-07-28 envelope + Mcp-Method/
  Mcp-Name headers); legacy SDK initialize is rejected (-32022). The runtime
  defaults to ModernMcpFree4ChatClient; `FREE4CHAT_MCP_LEGACY=1` reverts.
- Prod `/api/sfu/agent-session` uses the native initial-offer contract
  (offer rides on session creation); the bridge falls back to blank-session
  + datachannels/establish when that 400s.
- The daemon persists across CLI invocations and inherits env at FIRST
  spawn: kill it (or `cli.js stop`) before changing env like
  FREE4CHAT_STT_PROVIDER / DOUBAO_API_KEY / FREE4CHAT_MEDIA_ENGINE.
- STT requires `FREE4CHAT_STT_PROVIDER=doubao` + `DOUBAO_API_KEY`; absence
  degrades gracefully to text-only (fail-open verified).
