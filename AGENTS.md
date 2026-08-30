# free4chat — Agent Development Guide

## Project overview

Free4Chat is a no-sign-up real-time voice, text, file, and screen-sharing chat app.

- Live URL: https://www.free4.chat
- Canonical host: `www.free4.chat`; `free4.chat` redirects here at Cloudflare
- Production branch: `cf-sfu`
- Stack: Next.js 15 → Cloudflare Worker via `@opennextjs/cloudflare`
- Media: browser WebRTC → Cloudflare Realtime SFU
- Coordination: Cloudflare Durable Objects
- Agent Runtime: self-contained Go binary (`agent/`) — canonical; the frozen Node reference (`node-agent-runtime-e2e-2026-08-27` / `archive/node-agent-runtime`) is immutable history only

## Directory layout

```text
free4chat/
├── app/
│   ├── src/
│   │   ├── common/origin.ts          # shared origin allow-list
│   │   ├── common/types.tsx          # UserInfo and Message contracts
│   │   ├── common/agentInvite.ts     # room-scoped Agent bootstrap prompt
│   │   ├── do/RoomSession.ts         # room presence/chat/mute/state
│   │   ├── do/meetingNotesAuth.ts    # pure Meeting Notes grant decisions (testable)
│   │   ├── do/realtimeMedia.ts       # server-side Cloudflare Realtime track-close
│   │   ├── do/                       # RoomSession state coordination
│   │   ├── hooks/useSfuChatRoom.ts   # WebRTC, SFU negotiation, DataChannels
│   │   ├── components/RoomContent.tsx
│   │   ├── components/UserCard.tsx
│   │   ├── components/TextChatCard.tsx
│   ├── src/sfu/server.ts             # authenticated SFU API proxy
│   ├── src/room/server.ts            # transport-neutral room attachment upload
│   ├── src/mcp/server.ts             # stateless MCP Agent room endpoint
│   ├── src/room/types.ts             # transport-neutral room contracts
│   ├── public/agent.md               # machine-readable Agent protocol
│   ├── worker.ts                     # Worker entry and DO exports
│   ├── wrangler.jsonc                # production Worker config
│   └── .dev.vars.example
├── agent/                            # canonical Go Agent Runtime (self-contained binary)
│   ├── cmd/free4chat-agent/
│   ├── internal/{cli,daemon,free4chat,runtime,harness,media,speech,voice,...}
│   ├── scripts/release.sh            # native distribution build + SHA256SUMS
│   └── scripts/check-cleanup.sh      # distribution/cleanup contract check
└── .github/workflows/{deploy-web.yml,go-agent.yml,agent-release.yml}
```

The `agent/` Go module is a local, self-contained runtime, not part of the Worker. It owns resident Agent lifecycle and uses outbound MCP only. It must not expose a TCP/HTTP listener, persist participant capabilities, or be imported into the Cloudflare app. It ships only as native binaries (plus `SHA256SUMS`) from GitHub Releases; the frozen Node runtime is immutable history (tag `node-agent-runtime-e2e-2026-08-27`, branch `archive/node-agent-runtime`).

## SFU architecture

The browser connects directly to Cloudflare Realtime SFU. The Worker never exposes `SFU_APP_SECRET` to clients. `RoomSession` coordinates presence, chat, reactions, mute state, track metadata, DataChannel readiness, Agent targeting, and ephemeral Agent image and text-file attachments. It also owns the Meeting Notes authorization boundary (see below) — the only way any Agent participant can ever obtain Human audio; see [Meeting Notes / Agent media](#meeting-notes--agent-media-82).

All `/api/sfu/*` requests require an `Origin` of `https://free4.chat` or `https://www.free4.chat`; `http://localhost:3000` is allowed for local development. The Worker URL is not an allowed production origin.

`buildParticipants()` in `useSfuChatRoom.ts` is the single source of truth for participant UI state. Rebuild the complete list instead of patching individual React entries.

## SFU session flow

1. `/api/sfu/session` validates the origin, rate limit, Turnstile token, room, and name.
2. The Worker creates a Cloudflare Realtime session and registers the participant in `RoomSession`.
3. The browser establishes the server-events and file DataChannels.
4. The browser publishes microphone and optional screen-share tracks.
5. `RoomSession` broadcasts metadata; remote track subscriptions are authorized against the room state before being forwarded to Cloudflare.

The SFU App ID is a deployment variable. `SFU_APP_SECRET` and `TURNSTILE_SECRET_KEY` are Worker secrets and must never be committed or sent to the browser.

## Agent room protocol

`/mcp` is a stateless MCP v2 endpoint built with `createMcpHandler` from `agents/mcp/server` and `McpServer` from `@modelcontextprotocol/server`. It exposes fifteen tools — `room_info`, `join_room`, `create_room`, `wait_for_events`, `send_text`, `update_capabilities`, `send_collab_request`, `send_collab_response`, `send_collab_result`, `send_attachment`, `publish_surface`, `clear_surface`, `read_surface`, `read_attachment`, and `leave_room`; `app/public/agent.md` is the canonical contract. The opaque participant handle is a bearer capability containing the room and Agent participant credentials; never log, display, or send it anywhere except the Free4Chat MCP endpoint.

Agents are first-class `kind: "agent"` participants. `media` state is normally absent and is populated only for the room's currently-granted Meeting Notes note-taker (see below) — always subscribe-only, never publish (the one exception is the separately-granted #83 Voice Reply publication gate, below). The `/api/sfu/session` route always creates `kind: "human"` participants and must reject Agent sessions. Keep MCP state stateless at the Worker boundary: room participant leases, message cursors, long-poll waiters, sequence numbers, and expiry belong in `RoomSession`. Do not expose a public arbitrary room-control endpoint, OAuth, accounts, R2, or server-side file persistence.

The MCP/text protocol itself is text-only and always will be: no MCP tool ever returns or accepts SFU session IDs, participant tokens, track IDs, or DataChannel IDs. `room_info` returns sanitized participant data and capabilities, never tokens, connection nonces, SFU session IDs, track IDs, DataChannel IDs, or message history — it does surface the room-visible `meetingNotes` grant state (`active`/`agentParticipantId`), since that is public room state, not a capability secret; the same `agentParticipantId` is already visible in the participant list. `wait_for_events` is a bounded long-poll and lease heartbeat (0–25 seconds); it returns all room context with per-Agent `addressed` metadata. Human browser images remain DataChannel transfers; when an Agent is present, supported images (jpeg/png/webp ≤768KB) and text-like files (text/plain, text/markdown, text/csv, application/json) may also be stored as bounded ephemeral chunks for `read_attachment`; text attachments are returned decoded as UTF-8 in the tool result. Do not replace this with polling loops, queues, R2, or a second Durable Object.

For resident participation, the canonical Go runtime (`agent/`) owns the opaque participant handle, cursor, lease heartbeat, reconnect/rejoin, bounded sanitized event buffer, attachment reads, and Harness wakeup. One Free4Chat participant represents the runtime across many model turns. The Harness receives only sanitized room context and returns response text; it never receives the handle/token/cursor, SFU credentials, or raw media, and does not call the Free4Chat MCP tools directly. Use the official local programmatic interface for each adapter: Hermes TUI gateway JSON-RPC, Codex App Server, Claude Agent SDK, and Pi AgentSession. Do not auto-approve privileged Harness tools.

The same resident Runtime object may _also_ own a separate, optional Meeting Notes media capability (`media.Controller` + `media.Bridge`, both under `agent/internal/media/`) — see [Meeting Notes / Agent media](#meeting-notes--agent-media-82) for the full boundary. This is additive, not a second participant: there is exactly one visible Agent per resident Runtime, with an optional media capability layered on top, never a second "Hermes-media 🤖"-style duplicate.

## Meeting Notes / Agent media (#82)

A resident Agent's SFU media access is opt-in per room, explicit, and human-controlled — never implied by joining, never a standing capability, and never available through MCP:

- **Grant, not connection.** Media access requires a room-visible `meetingNotes` grant naming exactly one connected Agent as the note-taker (`RoomSession`'s `meetingNotes` state, decided by `do/meetingNotesAuth.ts`'s `isAgentAuthorizedForMedia`). A valid Agent participant token is necessary but never sufficient — an ordinary text-only Agent that joined the room but was never selected is rejected.
- **Every** Agent media operation — not just the initial `agent-session`/`agent-room-media` discovery calls — re-checks the _current_ grant: `RoomSession`'s shared `"authorize"` DO action (which backs `/api/sfu/tracks`, `/api/sfu/renegotiate`, `/api/sfu/tracks/close`, and `/api/sfu/datachannels/*`) rejects a non-authorized Agent even with a previously valid sessionId/participantId. Do not rely on `participantHandle`/sessionId opacity as a security boundary.
- **Stop is real revocation, not just a UI toggle.** Flipping the room-visible grant off does not by itself stop RTP already flowing over an established Cloudflare Realtime PeerConnection. `RoomSession` actively closes the granted Agent's subscribed tracks server-side (`do/realtimeMedia.ts`'s `closeRealtimeTracks`, using Cloudflare's `tracks/close` API) on every revocation trigger: explicit Stop, note-taker reassignment, the selected Agent leaving, its lease expiring, and room expiry. This is the enforced security boundary; a cooperative Runtime that stops polling and closes its own PeerConnection (`MeetingNotesController`) is a nice-to-have on top, not the guarantee. `closeRealtimeTracks` is fail-closed: only a confirmed 2xx counts as success — a non-2xx, missing credentials, or a network failure moves the mids into `RoomRecord.pendingMediaCleanup` instead of silently discarding them, and `RoomSession`'s `alarm()` retries that queue on a short interval (`MEDIA_CLEANUP_RETRY_MS`) until Cloudflare confirms the close. `pendingMediaCleanup` is never truncated to stay under a bound — the bound (`pendingCleanupHasCapacity`) is enforced by refusing _new_ Agent media work (a new grant, a new subscribed mid) while a backlog is outstanding, never by dropping data already queued for cleanup. The grant itself is still revoked immediately regardless of whether the Cloudflare call succeeds — the Human UI is never kept stuck showing "Listening" while cleanup retries in the background.
- **Never hold a Durable Object's in-memory `RoomRecord` across a `fetch()` and save it afterward.** Cloudflare can interleave handling of another incoming request while a Durable Object request is awaiting non-storage I/O (`fetch()` — storage ops like `ctx.storage.get/put` don't have this problem). Every revocation path (`stageAgentMediaRevocation`, called from `meeting-notes-stop`/`-start`/`agent-leave`/`alarm()`'s expiry sweep) is therefore split from the actual Cloudflare call: it _synchronously_ mutates the grant/`pendingMediaCleanup` and the caller persists + broadcasts that _before_ any `fetch()` happens; only afterward does `attemptCleanupNow` perform the Cloudflare close(s), and it re-reads a _fresh_ room and merges in only the specific mids that were just confirmed closed (`removeConfirmedMids`) rather than saving the stale, pre-fetch `RoomRecord` — so a concurrent request's newer state can never be silently overwritten. Keep this shape for any future DO code that mixes external I/O with room-state mutation.
- **The subscription commit closes the TOCTOU window, not just the steady state.** Between `/api/sfu/tracks`'s `authorize()` check and Cloudflare's `tracks/new` call completing, the grant can be revoked or reassigned — by which point Cloudflare has already created the subscription upstream. The Worker treats a rejected `agent-track-subscribed` registration (and a 2xx upstream response with no usable `mid`) as failure: it actively closes whatever Cloudflare just created (or hands it to `agent-media-cleanup-pending` for retry if that close doesn't confirm either) and never reports success to the Agent. Do not treat a 2xx from `/tracks` as sufficient on its own for an Agent's remote subscription — the mid must actually be captured and registered.
- **`AGENT_MEDIA_ENABLED`** is a coarse, environment-wide master switch, ANDed on top of the per-room grant — never a substitute for it. Turning it on does not by itself give any Agent audio access, and the browser must never show "Listening" or offer Start when it is off (see `RoomState.meetingNotesMediaAvailable`). `RoomSession` also refuses to _start_ a new grant while it's off (`meeting-notes-start` rejects with `meeting_notes_media_disabled`). If it flips off while a grant is already active, `MeetingNotesController` treats `meetingNotesMediaAvailable === false` as revocation and cooperatively stops within one poll cycle (`~5s`) — but this is a nice-to-have, not the guarantee: it does not by itself gate `/api/sfu/tracks`/`/renegotiate` for an already-authorized Agent, which remain governed purely by the room-visible grant (`isAgentAuthorizedForMedia`). Treat it as an admission switch for new grants/sessions plus a best-effort Runtime kill switch, not an instant, unconditional stop of already-flowing RTP.
- **Subscribe-only by default.** An Agent's SFU session remains publish-forbidden except for the #83 Voice Reply gate: `sfu/server.ts` rejects a `location: "local"` track for an agent-kind session before it ever reaches Cloudflare unless the request passes the voice-reply gate (`AGENT_MEDIA_ENABLED` on, purpose `voice-reply`, the room's `voiceReply` grant naming this participant, exactly one local audio track and no remote tracks — all failing closed before any Cloudflare call); `RoomSession`'s `"publish"` action rejects it again in the DO as defense in depth.
- **Rotating an Agent's Cloudflare session must not forget the old one's subscriptions.** `agent-media-attach` (called after `/sessions/new`, itself external I/O) re-checks the current grant before mutating anything, and — when replacing an existing session S1 with a new S2 rather than an idempotent re-attach of the same session — stages S1's already-tracked `agentSubscribedMids` into `pendingMediaCleanup` (reusing `stageAgentMediaRevocation`/`attemptCleanupNow`, the same pattern as every other revocation trigger) before ever pointing the participant at S2. Cloudflare does not close S1 merely because `RoomSession` stops referencing it.
- **A backpressured room rejects before creating more upstream subscriptions, not just after.** `/api/sfu/tracks` tells the DO's `"authorize"` action how many new Agent remote-subscribe tracks a request would create (`remoteTrackCount`); if that would exceed `MAX_AGENT_SUBSCRIBED_MIDS` or the room's `pendingMediaCleanup` is already at capacity, the request is rejected _before_ Cloudflare's `tracks/new` is ever called — not only afterward via `agent-track-subscribed`'s own check (finding #3/round 4), which still exists and is still required for the TOCTOU race where the grant is revoked _during_ `tracks/new`.
- **A duplicate/replayed Start for the already-active note-taker is idempotent.** `meeting-notes-start` does not generate a new grant epoch (`MeetingNotesState.startedAt`) when the named Agent already holds the active grant — only a genuine Stop-then-Start does. `MeetingNotesController` treats any epoch change as "the server already closed the previous session, rebuild the bridge," so a spurious epoch bump on a harmless replay would cause unnecessary media churn.
- **Runtime-owned streaming STT and opt-in Voice Reply TTS.** Meeting Notes media authorization remains #87's responsibility. Streaming STT is an optional Runtime-owned/BYOK downstream capability layered on top of the same subscribe-only ingress. Outbound voice is no longer future work: with `AGENT_MEDIA_ENABLED` on, the room's `voiceReply` grant naming this Agent, and TTS configured locally (Doubao Speech Synthesis 2.0 via `free4chat-agent speech setup`), the resident Runtime publishes synthesized Harness replies into the room — Runtime-owned/BYOK, and the MCP tools themselves remain text-only. Raw audio, STT partials, provider responses, and credentials stay Runtime-local and are never written to R2, KV, or DO storage. In contrast, committed bounded Live Transcript segments are explicit Room-shared ephemeral context: they may be persisted in bounded Room/DO state, remain available only within Room retention, and disappear on Room expiry.
- Do not solve a stale reading of this section by reverting to a permanently text-only resident Runtime or deleting `SfuMediaBridge`/`MeetingNotesController` — the model above **is** the intended boundary; extend it, don't collapse it.

## DataChannel file transfer

- Files and images use reliable, ordered DataChannels only.
- Maximum file size is 20 MB.
- Chunks are 32 KB with buffered-amount backpressure.
- Files are reconstructed as browser `Blob` object URLs and are never written to R2, KV, or DO storage.
- Object URLs and channels must be closed and revoked during room cleanup.

## Analytics

Use `umamiEvent()` or `trackAnalyticsEvent()` from `src/common/utils.ts`. The analytics bridge sends the same anonymized product events to Umami and Cloudflare Zaraz/Mixpanel. Room names must use `hashRoom()` and must never be sent raw.

## Development

```bash
# Web app
cd app
yarn install
cp .dev.vars.example .dev.vars
yarn dev

# Go Agent Runtime
cd agent
go build ./cmd/free4chat-agent
go test ./...
```

`.dev.vars` is gitignored. Never print or commit it. See `DEVELOPMENT.md` for deployment and secret setup. Native distribution: `agent/scripts/release.sh` builds the platform matrix plus `SHA256SUMS`; `agent/scripts/check-cleanup.sh` enforces the distribution/cleanup contract.

## Build and deployment

```bash
cd app
yarn cf-build
npx wrangler deploy \
  --var "SFU_APP_ID:$SFU_APP_ID"
```

Pushes to `cf-sfu` that touch `app/**` run lint, type-check, build, and deploy through GitHub Actions. CI does not manage production routes; routes already point to `free4chat-realtime`.

## Important constraints

- Keep `room.tsx` dynamic import with `ssr: false`.
- Keep audio enabled and camera/video disabled by default.
- Preserve the `LOCAL_PEER_ID = "local-peer-id"` sentinel.
- Keep the Worker URL out of the production origin allow-list.
- Do not add R2 or server-side file persistence.
- Agent attachment chunks are room-scoped ephemeral state and must be deleted on eviction and room expiry; never add public attachment URLs.
- Do not place participant capabilities in query strings, logs, analytics, or copied Agent prompts.
- Do not commit `.dev.vars`, generated secrets, or `*.tsbuildinfo`.
- The canonical Agent Runtime is the Go binary under `agent/`; the frozen Node runtime is immutable history — do not reintroduce the npm runtime or Node↔Pion provisioning machinery.
- `experiments/pion-cloudflare/` is historical experiment/reference source: preserve it, do not rewrite or delete it.
- Preserve the frozen tag `node-agent-runtime-e2e-2026-08-27` and archive branch `archive/node-agent-runtime`.
