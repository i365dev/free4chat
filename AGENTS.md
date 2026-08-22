# free4chat — Agent Development Guide

## Project overview

Free4Chat is a no-sign-up real-time voice, text, file, and screen-sharing chat app.

- Live URL: https://www.free4.chat
- Canonical host: `www.free4.chat`; `free4.chat` redirects here at Cloudflare
- Production branch: `cf-sfu`
- Stack: Next.js 15 → Cloudflare Worker via `@opennextjs/cloudflare`
- Media: browser WebRTC → Cloudflare Realtime SFU
- Coordination: Cloudflare Durable Objects

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
└── .github/workflows/deploy-web.yml
```

The optional top-level `agent-runtime/` package is a local Node.js process, not part of the Worker. It owns resident Agent lifecycle and uses outbound MCP only. It must not expose a TCP/HTTP listener, persist participant capabilities, or be imported into the Cloudflare app.

## SFU architecture

The browser connects directly to Cloudflare Realtime SFU. The Worker never exposes `SFU_APP_SECRET` to clients. `RoomSession` coordinates presence, chat, reactions, mute state, track metadata, DataChannel readiness, Agent targeting, and ephemeral Agent image attachments. It also owns the Meeting Notes authorization boundary (see below) — the only way any Agent participant can ever obtain Human audio; see [Meeting Notes / Agent media](#meeting-notes--agent-media-82).

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

`/mcp` is a stateless MCP v2 endpoint built with `createMcpHandler` from `agents/mcp/server` and `McpServer` from `@modelcontextprotocol/server`. It exposes `room_info`, `join_room`, `wait_for_events`, `send_text`, `read_attachment`, and `leave_room`. The opaque participant handle is a bearer capability containing the room and Agent participant credentials; never log, display, or send it anywhere except the Free4Chat MCP endpoint.

Agents are first-class `kind: "agent"` participants. `media` state is normally absent and is populated only for the room's currently-granted Meeting Notes note-taker (see below) — always subscribe-only, never publish. The `/api/sfu/session` route always creates `kind: "human"` participants and must reject Agent sessions. Keep MCP state stateless at the Worker boundary: room participant leases, message cursors, long-poll waiters, sequence numbers, and expiry belong in `RoomSession`. Do not expose a public arbitrary room-control endpoint, OAuth, accounts, R2, or server-side file persistence.

The MCP/text protocol itself is text-only and always will be: no MCP tool ever returns or accepts SFU session IDs, participant tokens, track IDs, or DataChannel IDs. `room_info` returns sanitized participant data and capabilities, never tokens, connection nonces, SFU session IDs, track IDs, DataChannel IDs, or message history — it does surface the room-visible `meetingNotes` grant state (`active`/`agentParticipantId`), since that is public room state, not a capability secret; the same `agentParticipantId` is already visible in the participant list. `wait_for_events` is a bounded long-poll and lease heartbeat (0–25 seconds); it returns all room context with per-Agent `addressed` metadata. Human browser images remain DataChannel transfers; when an Agent is present, a supported image may also be stored as bounded ephemeral chunks for `read_attachment`. Do not replace this with polling loops, queues, R2, or a second Durable Object.

For resident participation, `agent-runtime/` owns the opaque participant handle, cursor, lease heartbeat, reconnect/rejoin, bounded sanitized event buffer, attachment reads, and Harness wakeup. One Free4Chat participant represents the runtime across many model turns. The Harness receives only sanitized room context and returns response text; it never receives the handle/token/cursor, SFU credentials, or raw media, and does not call the Free4Chat MCP tools directly. Use the official local programmatic interface for each adapter: Hermes TUI gateway JSON-RPC, Codex App Server, Claude Agent SDK, and Pi AgentSession. Do not auto-approve privileged Harness tools.

The same resident Runtime object may *also* own a separate, optional Meeting Notes media capability (`MeetingNotesController` + `SfuMediaBridge`, both under `agent-runtime/src/media/`) — see [Meeting Notes / Agent media](#meeting-notes--agent-media-82) for the full boundary. This is additive, not a second participant: there is exactly one visible Agent per resident Runtime, with an optional media capability layered on top, never a second "Hermes-media 🤖"-style duplicate.

## Meeting Notes / Agent media (#82)

A resident Agent's SFU media access is opt-in per room, explicit, and human-controlled — never implied by joining, never a standing capability, and never available through MCP:

- **Grant, not connection.** Media access requires a room-visible `meetingNotes` grant naming exactly one connected Agent as the note-taker (`RoomSession`'s `meetingNotes` state, decided by `do/meetingNotesAuth.ts`'s `isAgentAuthorizedForMedia`). A valid Agent participant token is necessary but never sufficient — an ordinary text-only Agent that joined the room but was never selected is rejected.
- **Every** Agent media operation — not just the initial `agent-session`/`agent-room-media` discovery calls — re-checks the *current* grant: `RoomSession`'s shared `"authorize"` DO action (which backs `/api/sfu/tracks`, `/api/sfu/renegotiate`, `/api/sfu/tracks/close`, and `/api/sfu/datachannels/*`) rejects a non-authorized Agent even with a previously valid sessionId/participantId. Do not rely on `participantHandle`/sessionId opacity as a security boundary.
- **Stop is real revocation, not just a UI toggle.** Flipping the room-visible grant off does not by itself stop RTP already flowing over an established Cloudflare Realtime PeerConnection. `RoomSession` actively closes the granted Agent's subscribed tracks server-side (`do/realtimeMedia.ts`'s `closeRealtimeTracks`, using Cloudflare's `tracks/close` API) on every revocation trigger: explicit Stop, note-taker reassignment, the selected Agent leaving, its lease expiring, and room expiry. This is the enforced security boundary; a cooperative Runtime that stops polling and closes its own PeerConnection (`MeetingNotesController`) is a nice-to-have on top, not the guarantee.
- **`AGENT_MEDIA_ENABLED`** is a coarse, environment-wide master switch, ANDed on top of the per-room grant — never a substitute for it. Turning it on does not by itself give any Agent audio access, and the browser must never show "Listening" or offer Start when it is off (see `RoomState.meetingNotesMediaAvailable`).
- **Subscribe-only, still.** An Agent's SFU session remains publish-forbidden (`sfu/server.ts` rejects a `location: "local"` track for an agent-kind session before it ever reaches Cloudflare; `RoomSession`'s `"publish"` action rejects it again in the DO as defense in depth).
- **No STT, no TTS, no transcript, no summarization, no persistence.** `SfuMediaBridge` only ingests bounded diagnostic audio-frame events; raw audio is never written to R2, KV, or DO storage. STT/TTS remain a future, Runtime-owned/BYOK capability layered on top of this same subscribe-only ingress — implementing them is a separate, later change, not part of this boundary.
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
cd app
yarn install
cp .dev.vars.example .dev.vars
yarn dev
```

`.dev.vars` is gitignored. Never print or commit it. See `DEVELOPMENT.md` for deployment and secret setup.

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
