# free4chat

[free4.chat](https://free4.chat/) is a real-time voice + text chat service. No sign-up, no server to run — just open a room and talk.

> ⚠️ Personal project / experimental. Use at your own risk.

## Why Cloudflare (branch history)

This project has gone through three stacks, always with the same product goal — a dead-simple, no-login voice + text room:

| Branch                         | Stack                            | Why it changed                                                                                                                   |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`golang`](../../tree/golang)  | Go + Pion WebRTC + coturn        | Self-hosted infra is too much overhead for a small personal project                                                              |
| [`elixir`](../../tree/elixir)  | Elixir + Membrane Framework      | Membrane eventually added file transfer support, but maintaining your own server cluster is still heavy for something this small |
| **`cloudflare`** (this branch) | Cloudflare RealtimeKit + Workers | Fully serverless — no servers to manage, file transfer built-in, free tier covers personal use                                   |

The product never changed. The ops burden did.

## Features

- 🎙️ Voice chat in rooms
- 💬 Text chat with emoji
- 📎 File & image transfer (inline preview)
- 🖥️ Screen sharing
- 🤖 Luna — optional AI assistant in the room (mention `@luna` to invoke)
- 🔒 No accounts, no persistent data
- 🛡️ Cloudflare Turnstile bot protection (full-page gate, transparent to real users)

## Privacy & Local-First Design

free4chat is built around two principles: **no data outlives the conversation**, and **you don't need to trust any server**.

**What we don't store:**

- No accounts, no sign-up, no identity
- Messages exist only in participants' browser memory — close the tab and they're gone
- Files and images are transferred via WebRTC data channels, never written to any database
- Voice is relayed through Cloudflare's media nodes but never recorded

**What does persist (and why it's fine):**

- A `room name → meeting ID` mapping is kept in Cloudflare KV with a 30-day TTL, so rejoining the same room name works within a session. It contains no messages, no users, no content.
- When Luna AI is enabled, messages sent to `@luna` are transmitted to an external AI model (Cloudflare AI Gateway → `@cf/zai-org/glm-4.7-flash`) for processing. The last 20 messages of conversation context are retained in a Durable Object for the lifetime of the room session only. Luna is opt-in and disabled by default.
- Your nickname is saved in browser `localStorage` for convenience. Clear it anytime.

**Why "local-first":**
The application runs entirely in your browser. The Worker's only job is to issue a short-lived auth token — after that, all communication is peer-to-peer or via Cloudflare's media plane with no application-layer logging.

## Tech Stack

| Layer    | Technology                                                                           |
| -------- | ------------------------------------------------------------------------------------ |
| Frontend | Next.js 15, Tailwind CSS, Cloudflare RealtimeKit React SDK                           |
| API      | Next.js API routes deployed as Cloudflare Worker via `@opennextjs/cloudflare`        |
| AI       | `BotSession` Durable Object → Cloudflare AI Gateway → `@cf/zai-org/glm-4.7-flash`    |
| Storage  | Cloudflare KV (room metadata, rate limiting) + DO KV storage (Luna chat history)     |
| Media    | Cloudflare RealtimeKit (WebRTC, audio, data channels, screen sharing)                |
| Security | Cloudflare Turnstile (full-page bot challenge) + origin whitelist + KV rate limiting |

## Local Development

### Prerequisites

- Node.js 22+
- A Cloudflare account with RealtimeKit enabled

### Setup

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
| `CF_AI_GATEWAY_BASEURL`       | AI Gateway base URL, ending in `/compat` (no trailing path) |
| `CF_AIG_TOKEN`                | AI Gateway auth token                                       |

Optional (bot protection, safe to omit locally):

| Variable               | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret — if set, all `/api/token` calls require a valid token |

## Deployment

Everything deploys as a single Cloudflare Worker (Next.js + API routes + Durable Object bundled together).

### GitHub Actions (automatic)

Set these repository secrets in GitHub:

| Secret                           | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`           | Cloudflare API token                                   |
| `CLOUDFLARE_ACCOUNT_ID`          | Your Cloudflare account ID                             |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key (baked into frontend at build time) |

Push to `cloudflare` branch with changes in `app/` → lint + type-check → deploy.

### Worker Runtime Secrets

Set these once via Wrangler (not in git):

```bash
cd app
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put RTK_APP_ID
npx wrangler secret put RTK_AUDIO_PRESET_NAME
npx wrangler secret put RTK_SCREENSHARE_PRESET_NAME
npx wrangler secret put CF_AIG_TOKEN
npx wrangler secret put CF_AI_GATEWAY_BASEURL   # value: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat
npx wrangler secret put TURNSTILE_SECRET_KEY
```

### Manual Deploy

```bash
cd app
yarn cf-build    # opennextjs build + patch BotSession DO into worker.js
yarn cf-deploy   # wrangler deploy
```

`cf-build` runs `scripts/patch-worker.mjs` after the opennextjs build to bundle and inject the `BotSession` Durable Object export into `.open-next/worker.js`. This is required because `opennextjs-cloudflare` ignores custom `main` entrypoints and always emits its own `worker.js`.

## Directory Structure

```
free4chat/
├── app/
│   ├── scripts/
│   │   └── patch-worker.mjs          # post-build: injects BotSession DO into worker.js
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

## Future Technical Directions

These are not on the immediate roadmap but are worth knowing about when the product grows.

### SQLite-backed Durable Objects

`BotSession` currently uses DO KV storage (`state.storage.get/put`). This is fine for the current use case (a small history array + two counters). If the data model grows — per-user memory, room summaries, structured query needs — migrating to SQLite DO storage (`this.state.storage.sql`) is straightforward and unlocks Cloudflare's Data Studio for debugging.

### Cloudflare Actors library

Cloudflare's Actors library is a higher-level abstraction over Durable Objects that replaces manual `fetch()` dispatch with typed RPC method calls. Worth adopting if `BotSession` grows multiple methods or is called from multiple Workers. No benefit at current scale.

### Voice Bot (Phase 2 Luna)

The text bot (Luna Phase 1) is shipped. Voice bot would require:

- `@cloudflare/voice` Durable Object (STT → LLM → TTS pipeline)
- Cloudflare Calls API track bridging to inject audio into the RTK room
- Estimated latency: ~700–900ms all-Cloudflare, ~465ms with Deepgram + Groq + ElevenLabs

See [issue #52](https://github.com/i365dev/free4chat/issues/52) for full architecture.

### Slash / @ Command Input

Type `/` or `@` in the chat input to trigger an inline command picker: `/draw`, `/poll`, `/games`, `/luna`. Selecting a command launches the action directly or inserts `@luna` for AI invocation.

## License

MIT
