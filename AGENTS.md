# free4chat — Agent Development Guide

## Project overview

Free4Chat is a no-sign-up real-time voice, text, file, and screen-sharing chat app.

- Live URL: https://free4.chat
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
│   │   ├── do/RoomSession.ts         # room presence/chat/mute/state
│   │   ├── do/                       # RoomSession state coordination
│   │   ├── hooks/useSfuChatRoom.ts   # WebRTC, SFU negotiation, DataChannels
│   │   ├── components/RoomContent.tsx
│   │   ├── components/UserCard.tsx
│   │   ├── components/TextChatCard.tsx
│   ├── src/sfu/server.ts             # authenticated SFU API proxy
│   ├── src/mcp/server.ts             # stateless MCP Agent room endpoint
│   ├── src/room/types.ts             # transport-neutral room contracts
│   ├── public/agent.md               # machine-readable Agent protocol
│   ├── worker.ts                     # Worker entry and DO exports
│   ├── wrangler.jsonc                # production Worker config
│   └── .dev.vars.example
└── .github/workflows/deploy-web.yml
```

## SFU architecture

The browser connects directly to Cloudflare Realtime SFU. The Worker never exposes `SFU_APP_SECRET` to clients. `RoomSession` only coordinates presence, chat, reactions, mute state, track metadata, DataChannel readiness, and room expiry.

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

`/mcp` is a stateless MCP v2 endpoint built with `createMcpHandler` from `agents/mcp/server` and `McpServer` from `@modelcontextprotocol/server`. It exposes only `room_info`, `join_room`, `wait_for_events`, `send_text`, and `leave_room`. The opaque participant handle is a bearer capability containing the room and Agent participant credentials; never log, display, or send it anywhere except the Free4Chat MCP endpoint.

Agents are first-class `kind: "agent"` participants with no `media` state. The `/api/sfu/session` route always creates `kind: "human"` participants and must reject Agent sessions. Keep MCP state stateless at the Worker boundary: room participant leases, message cursors, long-poll waiters, sequence numbers, and expiry belong in `RoomSession`. Do not expose a public arbitrary room-control endpoint, OAuth, accounts, R2, or server-side file persistence.

Agent room capabilities are text-only in Phase 1a. `room_info` returns sanitized participant data and capabilities, never tokens, connection nonces, SFU session IDs, track IDs, DataChannel IDs, or message history. `wait_for_events` is a bounded long-poll and lease heartbeat (0–25 seconds); do not replace it with polling loops, queues, or a second Durable Object.

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
- Do not commit `.dev.vars`, generated secrets, or `*.tsbuildinfo`.
