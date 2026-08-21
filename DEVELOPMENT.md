# Development

## Prerequisites

- Node.js 22+
- A Cloudflare account with RealtimeKit enabled
- For the isolated SFU PoC only: a Cloudflare Realtime SFU App ID and App Secret

## Local Setup

```bash
cd app
yarn install
cp .dev.vars.example .dev.vars   # fill in your credentials
yarn dev                          # starts on http://localhost:3000
```

Required values in `app/.dev.vars`:

| Variable                      | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `CF_API_TOKEN`                | Cloudflare API token with Workers + RealtimeKit access      |
| `CF_ACCOUNT_ID`               | Your Cloudflare account ID                                  |
| `RTK_APP_ID`                  | RealtimeKit app ID                                          |
| `RTK_AUDIO_PRESET_NAME`       | RTK preset for audio-only rooms                             |
| `RTK_SCREENSHARE_PRESET_NAME` | RTK preset for screenshare rooms                            |
| `SFU_APP_ID`                  | Cloudflare Realtime SFU App ID                              |
| `SFU_APP_SECRET`              | Cloudflare Realtime SFU App Secret                         |
| `CF_AI_GATEWAY_BASEURL`       | AI Gateway base URL, ending in `/compat` (no trailing path) |
| `CF_AIG_TOKEN`                | AI Gateway auth token                                       |

Optional — safe to omit locally:

| Variable               | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret — if set, all `/api/token` calls require a valid token |

## Deployment

Everything deploys as a single Cloudflare Worker (Next.js + API routes + Durable Object bundled together).

### GitHub Actions (automatic)

Push to `cf-sfu` branch with changes in `app/` → lint + type-check → deploy `free4chat-realtime`.

Required repository secrets:

| Secret                           | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`           | Cloudflare API token                                   |
| `CLOUDFLARE_ACCOUNT_ID`          | Your Cloudflare account ID                             |
| `SFU_APP_ID`                     | Cloudflare Realtime SFU app ID                         |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key (baked into frontend at build time) |

### Worker Runtime Secrets

Set these once via Wrangler (not in git):

```bash
cd app
npx wrangler secret put SFU_APP_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
```

### Manual Deploy

```bash
cd app
yarn cf-build
npx wrangler deploy --config wrangler.realtime.jsonc \
  --var "SFU_APP_ID:$SFU_APP_ID" \
  --var "SFU_ALLOWED_ORIGIN:https://free4.chat,https://www.free4.chat"
```

`cf-build` produces `.open-next/worker.js`; Wrangler then bundles `worker.ts`, which imports that handler and exports the `BotSession` and `RoomSession` Durable Objects.

## Cloudflare Realtime SFU

The production room path uses the raw SFU by default. Use `transport=rtk` only when testing the legacy RealtimeKit path:

```text
https://free4.chat/room?id=<room-name>
```

The SFU path uses a `RoomSession` Durable Object with hibernating WebSockets for presence, mute state, text, reactions, resync and room expiry. Cloudflare Realtime SFU carries audio and screen-share media; the browser performs the SFU session/track negotiation. Files and images use chunked, reliable DataChannels and are not persisted.

The SFU path requires `SFU_APP_ID` and `SFU_APP_SECRET`. Luna is intentionally disabled on the SFU path for now.

## Directory Structure

```
free4chat/
├── app/
│   ├── worker.ts                     # Worker entry: OpenNext, scheduled handler and DO exports
│   ├── src/
│   │   ├── components/
│   │   │   ├── TurnstileGate.tsx      # full-page bot challenge (wraps all pages)
│   │   │   ├── RoomContent.tsx        # room layout, screen share, @luna relay
│   │   │   ├── TextChatCard.tsx       # chat panel, activity strip, Luna pill
│   │   │   └── UserCard.tsx           # per-participant card
│   │   ├── do/
│   │   │   └── BotSession.ts          # Durable Object: Luna chat history + rate limit
│   │   ├── hooks/
│   │   │   └── useChatRoom.ts         # core RealtimeKit hook
│   │   └── pages/
│   │       ├── _app.tsx               # TurnstileGate wrapper
│   │       ├── index.tsx              # landing page
│   │       ├── room.tsx               # room page (dynamic import, ssr: false)
│   │       └── api/
│   │           ├── token.ts           # POST /api/token — issues RTK auth token
│   │           └── bot.ts             # POST /api/bot — proxies to BotSession DO
│   ├── wrangler.jsonc
│   └── open-next.config.ts
└── .github/
    └── workflows/
        └── deploy-web.yml             # CI: lint + type-check → deploy
```

## Architecture Notes

### BotSession DO Export

The current Worker entry is `worker.ts`. It imports the OpenNext handler from `.open-next/worker.js`, preserves the scheduled handler, and exports both Durable Object classes. `wrangler.jsonc` points to `worker.ts`.

### Turnstile Flow

`TurnstileGate` wraps all pages in `_app.tsx`. On first load it shows a full-screen challenge; on pass it stores the token in `sessionStorage`. The token is sent with every `/api/token` request and cleared after a successful join. Navigating back to the landing page after leaving a room resets the gate if the token has been consumed.

### RTK Hook Pattern

The app uses `useRealtimeKitClient` (low-level) — not the higher-level React hooks. All RTK state is managed imperatively through the `meeting` object inside `useChatRoom.ts`. `buildParticipants()` is the single source of truth for participant state — always rebuilds the full list, never patches individual entries.

## Future Directions

### SQLite-backed Durable Objects

`BotSession` uses DO KV storage (`state.storage.get/put`). Fine for current use. If the data model grows, migrating to `this.state.storage.sql` is straightforward and unlocks Cloudflare Data Studio for debugging.

### Cloudflare Actors Library

Higher-level abstraction over Durable Objects with typed RPC. Worth adopting if `BotSession` grows multiple methods or is called from multiple Workers. No benefit at current scale.

### Voice Bot (Luna Phase 2)

Requires `@cloudflare/voice` Durable Object (STT → LLM → TTS) + Cloudflare Calls API track bridging into RTK. Estimated latency: ~700–900ms all-Cloudflare. See [issue #55](https://github.com/i365dev/free4chat/issues/55).
