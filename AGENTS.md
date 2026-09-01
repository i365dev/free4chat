# free4chat — Agent Development Guide

## Project overview

Free4Chat is a no-sign-up temporary collaboration space. A Room is a
short-lived collaboration domain for peer Human and Agent participants, not a
permanent chat history, project workspace, or orchestration system. Free4Chat
owns bounded Room availability and transport; each participant keeps its own
intelligence, tools, credentials, private context, permissions, and durable
state. Human-to-Human voice and text remain first-class, and Humanless Agent
Rooms are valid.

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
│   │   ├── do/RoomSession.ts         # room presence/context/media state
│   │   ├── do/meetingNotesAuth.ts    # legacy compatibility + media grant decisions
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

The browser connects directly to Cloudflare Realtime SFU. The Worker never exposes `SFU_APP_SECRET` to clients. `RoomSession` coordinates presence, chat, reactions, mute state, track metadata, DataChannel readiness, Agent targeting, committed Room-wide Live Transcript, and bounded Agent-readable attachments. It is the authorization boundary for every Agent media path: the legacy Meeting Notes compatibility grant, the exact active Live Transcript producer on a verified Runtime Host provider, and per-Agent Voice Reply are separate permissions. A public `runtimeHostId`, capability advertisement, or Agent token alone is never enough to obtain Human audio; see [legacy Meeting Notes compatibility and Agent media](#legacy-meeting-notes-compatibility-and-agent-media).

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

`/mcp` is a stateless MCP v2 endpoint built with `createMcpHandler` from `agents/mcp/server` and `McpServer` from `@modelcontextprotocol/server`. It exposes sixteen tools — `room_info`, `join_room`, `create_room`, `wait_for_events`, `send_text`, `update_capabilities`, `update_runtime_host`, `send_collab_request`, `send_collab_response`, `send_collab_result`, `send_attachment`, `publish_surface`, `clear_surface`, `read_surface`, `read_attachment`, and `leave_room`; `app/public/agent.md` is the canonical contract. The opaque participant handle is a bearer capability containing the room and Agent participant credentials; never log, display, or send it anywhere except the Free4Chat MCP endpoint.

Agents are first-class `kind: "agent"` participants. An Agent media session is normally absent and exists only under a current Room authorization: the legacy Meeting Notes compatibility grant, the exact active Live Transcript producer, or a separately granted Voice Reply path. The `/api/sfu/session` route always creates `kind: "human"` participants and must reject Agent sessions. Keep MCP state stateless at the Worker boundary: room participant leases, message cursors, long-poll waiters, sequence numbers, and expiry belong in `RoomSession`. Do not expose a public arbitrary room-control endpoint, OAuth, accounts, R2, or server-side file persistence.

The MCP/text protocol itself is text-only and always will be: no MCP tool ever returns or accepts SFU session IDs, participant tokens, track IDs, or DataChannel IDs. `room_info` returns sanitized participant/capability data and bounded committed Live Transcript context where present; it never returns ordinary chat history, tokens, connection nonces, provider proofs, SFU session IDs, track IDs, or DataChannel IDs. Transcript visibility is Room context, not an ordinary message and not a Harness wakeup; explicit addressing remains the activation boundary. `wait_for_events` is a bounded long-poll and lease heartbeat (0–25 seconds); it returns sanitized event context with per-Agent `addressed` metadata. Human browser-to-browser images remain DataChannel transfers; a bounded temporary image copy may exist for Agent inspection, and explicit Room attachments support jpeg/png/webp plus text/plain, text/markdown, text/csv, application/json, and text/yaml (≤768KB). Text attachments are returned decoded as UTF-8 in the tool result. Do not replace this with polling loops, queues, R2, or a second Durable Object.

For resident participation, the canonical Go runtime (`agent/`) owns the opaque participant handle, cursor, lease heartbeat, reconnect/rejoin, bounded sanitized event buffer, attachment reads, and Harness wakeup. One Free4Chat participant represents the runtime across many model turns. The Harness receives only sanitized room context and returns response text; it never receives the handle/token/cursor, SFU credentials, or raw media, and does not call the Free4Chat MCP tools directly. The Runtime speaks generic ACP v1 through its launcher registry: Hermes, OpenCode, Codex, Claude, Pi, DeepSeek Harness preview, and a trusted local custom ACP command all use the same retained-session adapter. Do not auto-approve privileged Harness tools.

The same resident Runtime object may also own optional media controllers/bridges under `agent/internal/media/` for Live Transcript ingress, legacy Meeting Notes compatibility, and Voice Reply. This is additive, not a second participant: there is exactly one visible Agent per resident Runtime, never a duplicate media-only Agent.

## Legacy Meeting Notes compatibility and Agent media

The legacy Meeting Notes grant remains implemented for compatibility but is not the current browser product model. Current Live Transcript is Room-wide shared context produced by one Human-authorized STT-ready Runtime Host; it is not an Agent note-taker grant. All resident Agent SFU media paths remain opt-in per Room, explicit, human-controlled, never implied by joining, never a standing capability, and never available through MCP:

- **Room authorization, not connection.** A valid Agent participant token is necessary but never sufficient. Human-audio subscription requires either a room-visible legacy `meetingNotes` grant naming the Agent or an active Live Transcript whose exact producer Runtime Host is linked through its private server-side provider association; Voice Reply is a separate publication grant. Capability metadata and public `runtimeHostId` values never authorize anything.
- **Every** Agent media operation — not just the initial `agent-session`/`agent-room-media` discovery calls — re-checks the _current_ Room authorization: `RoomSession`'s shared `"authorize"` DO action (which backs `/api/sfu/tracks`, `/api/sfu/renegotiate`, `/api/sfu/tracks/close`, and `/api/sfu/datachannels/*`) rejects a non-authorized Agent even with a previously valid sessionId/participantId. Do not rely on `participantHandle`/sessionId opacity as a security boundary.
- **Stop is real revocation, not just a UI toggle.** Stopping Live Transcript or revoking a legacy Meeting Notes grant does not merely change Room state while RTP keeps flowing. `RoomSession` actively closes subscribed tracks server-side (`do/realtimeMedia.ts`'s `closeRealtimeTracks`, using Cloudflare's `tracks/close` API) when the applicable authorization is stopped, invalidated, reassigned, or its participant/host expires. This is the enforced boundary; a cooperative Runtime that stops its controller/bridge is useful but not the guarantee. `closeRealtimeTracks` is fail-closed: only a confirmed 2xx counts as success — a non-2xx, missing credentials, or a network failure moves the mids into `RoomRecord.pendingMediaCleanup` instead of silently discarding them, and `RoomSession`'s `alarm()` retries that queue on a short interval (`MEDIA_CLEANUP_RETRY_MS`) until Cloudflare confirms the close. `pendingMediaCleanup` is never truncated to stay under a bound — the bound (`pendingCleanupHasCapacity`) is enforced by refusing _new_ Agent media work while a backlog is outstanding, never by dropping data already queued for cleanup. Authorization is revoked in Room state immediately regardless of cleanup success.
- **Never hold a Durable Object's in-memory `RoomRecord` across a `fetch()` and save it afterward.** Cloudflare can interleave handling of another incoming request while a Durable Object request is awaiting non-storage I/O (`fetch()` — storage ops like `ctx.storage.get/put` don't have this problem). Every revocation path (`stageAgentMediaRevocation` and `stageLiveTranscriptMediaRevocation`, called from a Stop, departure, normalization, or `alarm()` sweep) is therefore split from the actual Cloudflare call: it _synchronously_ mutates the authorization/`pendingMediaCleanup` and the caller persists + broadcasts that _before_ any `fetch()` happens; only afterward does `attemptCleanupNow` perform the Cloudflare close(s), and it re-reads a _fresh_ room and merges in only the specific mids that were just confirmed closed (`removeConfirmedMids`) rather than saving the stale, pre-fetch `RoomRecord` — so a concurrent request's newer state can never be silently overwritten. Keep this shape for any future DO code that mixes external I/O with room-state mutation.
- **The subscription commit closes the TOCTOU window, not just the steady state.** Between `/api/sfu/tracks`'s `authorize()` check and Cloudflare's `tracks/new` call completing, Room authorization can be revoked or invalidated — by which point Cloudflare has already created the subscription upstream. The Worker treats a rejected `agent-track-subscribed` registration (and a 2xx upstream response with no usable `mid`) as failure: it actively closes whatever Cloudflare just created (or hands it to `agent-media-cleanup-pending` for retry if that close doesn't confirm either) and never reports success to the Agent. Do not treat a 2xx from `/tracks` as sufficient on its own for an Agent's remote subscription — the mid must actually be captured and registered.
- **`AGENT_MEDIA_ENABLED`** is a coarse, environment-wide master switch, ANDed on top of per-Room authorization — never a substitute for it. Turning it on does not by itself give any Agent audio access, and the browser must never offer Live Transcript Start when the associated media availability projection is off. `RoomSession` refuses new media work while it is off; a Runtime also cooperatively stops on the corresponding state edge. The server-side Room authorization and tracked track-close path remain the enforcement boundary for already-flowing RTP.
- **Subscribe-only by default.** An Agent's SFU session remains publish-forbidden except for the #83 Voice Reply gate: `sfu/server.ts` rejects a `location: "local"` track for an agent-kind session before it ever reaches Cloudflare unless the request passes the voice-reply gate (`AGENT_MEDIA_ENABLED` on, purpose `voice-reply`, the room's `voiceReply` grant naming this participant, exactly one local audio track and no remote tracks — all failing closed before any Cloudflare call); `RoomSession`'s `"publish"` action rejects it again in the DO as defense in depth.
- **Rotating an Agent's Cloudflare session must not forget the old one's subscriptions.** `agent-media-attach` (called after `/sessions/new`, itself external I/O) re-checks the current grant before mutating anything, and — when replacing an existing session S1 with a new S2 rather than an idempotent re-attach of the same session — stages S1's already-tracked `agentSubscribedMids` into `pendingMediaCleanup` (reusing `stageAgentMediaRevocation`/`attemptCleanupNow`, the same pattern as every other revocation trigger) before ever pointing the participant at S2. Cloudflare does not close S1 merely because `RoomSession` stops referencing it.
- **A backpressured room rejects before creating more upstream subscriptions, not just after.** `/api/sfu/tracks` tells the DO's `"authorize"` action how many new Agent remote-subscribe tracks a request would create (`remoteTrackCount`); if that would exceed `MAX_AGENT_SUBSCRIBED_MIDS` or the room's `pendingMediaCleanup` is already at capacity, the request is rejected _before_ Cloudflare's `tracks/new` is ever called — not only afterward via `agent-track-subscribed`'s own check (finding #3/round 4), which still exists and is still required for the TOCTOU race where the grant is revoked _during_ `tracks/new`.
- **A duplicate/replayed legacy Meeting Notes Start is idempotent.** `meeting-notes-start` does not generate a new grant epoch (`MeetingNotesState.startedAt`) when the named Agent already holds the active grant — only a genuine Stop-then-Start does. The legacy controller treats any epoch change as "the server already closed the previous session, rebuild the bridge," so a spurious epoch bump on a harmless replay would cause unnecessary media churn.
- **Runtime-owned streaming STT and opt-in Voice Reply TTS.** Room-wide Live Transcript is an optional Runtime-owned/BYOK capability layered on top of authorized subscribe-only ingress. One authorized STT-ready Host produces committed attributed segments; all current participants see the same bounded Room context, and a Runtime includes it in a Harness turn only after that Agent is explicitly targeted. Outbound voice is separate: with `AGENT_MEDIA_ENABLED` on, the room's `voiceReply` grant naming this Agent, and TTS configured locally (Doubao Speech Synthesis 2.0 via `free4chat-agent speech setup`), the resident Runtime publishes synthesized Harness replies into the room. Raw audio, STT partials, provider responses, and credentials stay Runtime-local and are never written to R2, KV, or DO storage. Committed Live Transcript segments may be persisted in bounded Room/DO state, remain available only within Room retention, and disappear on Room expiry.
- Do not solve a stale reading of this section by reverting to a permanently text-only resident Runtime or deleting the media bridge/controller architecture — the model above is the intended boundary; extend it, do not collapse it.

## DataChannel file transfer

- Human browser-to-browser files and images use reliable, ordered DataChannels only.
- Maximum file size is 20 MB.
- Chunks are 32 KB with buffered-amount backpressure.
- Browser transfers are reconstructed as `Blob` object URLs and are never written to R2, KV, or DO storage. Bounded Agent-readable image copies and explicit Room attachments are separate Room-state paths described above.
- Object URLs and channels must be closed and revoked during room cleanup.

## Analytics

Use `umamiEvent()` or `trackAnalyticsEvent()` from `src/common/utils.tsx`. The analytics bridge sends the same anonymized product events to Umami and Cloudflare Zaraz/Mixpanel. Room names must use `hashRoom()` and must never be sent raw; never send participant names, handles, transcript/message/artifact content, filenames, credentials, session IDs, or arbitrary user input.

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
- `experiments/pion-cloudflare/` was removed after the in-process Go Runtime reached parity. Do not restore the obsolete sidecar experiment to the canonical branch; historical provenance lives in the frozen tag and archive branch below.
- Preserve the frozen tag `node-agent-runtime-e2e-2026-08-27` and archive branch `archive/node-agent-runtime`.
