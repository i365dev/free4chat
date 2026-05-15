# free4chat

[free4.chat](https://free4.chat/) is a real-time audio + text chat service. No sign-up, no server to run — just open a room and talk.

> ⚠️ Personal project / experimental. Use at your own risk.

## Why Cloudflare (branch history)

This project has gone through three stacks, always with the same product goal — a dead-simple, no-login voice + text room:

| Branch | Stack | Why it changed |
|---|---|---|
| [`golang`](../../tree/golang) | Go + Pion WebRTC + coturn | Self-hosted infra is too much overhead for a small personal project |
| [`elixir`](../../tree/elixir) | Elixir + Membrane Framework | Membrane eventually added file transfer support, but maintaining your own server cluster is still heavy for something this small |
| **`cloudflare`** (this branch) | Cloudflare RealtimeKit + Workers | Fully serverless — no servers to manage, file transfer built-in, free tier covers personal use |

The product never changed. The ops burden did.

## Features

- 🎙️ Voice chat in rooms
- 💬 Text chat with emoji
- 📎 File & image transfer (inline preview)
- 🖥️ Screen sharing
- 🔒 No accounts, no persistent data

## Privacy & Local-First Design

free4chat is built around two principles: **no data outlives the conversation**, and **you don't need to trust any server**.

**What we don't store:**
- No accounts, no sign-up, no identity
- Messages exist only in participants' browser memory — close the tab and they're gone
- Files and images are transferred via WebRTC data channels, never written to any database
- Voice is relayed through Cloudflare's media nodes but never recorded

**What does persist (and why it's fine):**
- A `room name → meeting ID` mapping is kept in Cloudflare KV with a 30-day TTL, so rejoining the same room name works within a session. It contains no messages, no users, no content.
- Your nickname is saved in browser `localStorage` for convenience. Clear it anytime.

**Why "local-first":**
The application runs entirely in your browser. The Worker's only job is to issue a short-lived auth token so you can join a WebRTC session — after that, all communication is peer-to-peer or via Cloudflare's media plane with no application-layer logging. There is no backend that could be subpoenaed for chat history, because there is no chat history.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, Tailwind CSS, Cloudflare RealtimeKit React SDK |
| API | Next.js API route (`/api/token`) deployed as Cloudflare Worker via opennextjs |
| Storage | Cloudflare KV (room name → meeting ID mapping, 30-day TTL) |
| Media | Cloudflare RealtimeKit (WebRTC, audio/video/data channels, screen sharing) |

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

| Variable | Description |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token with Workers + RealtimeKit access |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID |
| `RTK_APP_ID` | RealtimeKit app ID |
| `RTK_PRESET_NAME` | Preset name configured in RealtimeKit dashboard |

## Deployment

Everything deploys as a single Cloudflare Worker (Next.js + API route bundled together via `@opennextjs/cloudflare`).

### GitHub Actions (automatic)

Set these repository secrets in GitHub:

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Push to `cloudflare` branch with changes in `app/` → auto-deploys via GitHub Actions.

### Worker Runtime Secrets

Set these once via Wrangler (not in git):

```bash
cd app
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put RTK_APP_ID
npx wrangler secret put RTK_PRESET_NAME
```

### Manual Deploy

```bash
cd app
yarn cf-build
yarn cf-deploy
```

## Directory Structure

```
free4chat/
├── app/                          # Next.js app (frontend + API, deploys as one Worker)
│   ├── src/
│   │   ├── hooks/useChatRoom.ts  # core RealtimeKit hook
│   │   ├── components/           # UI components
│   │   └── pages/
│   │       └── api/token.ts      # token API route (runs in Worker)
│   ├── wrangler.jsonc            # Cloudflare Worker config
│   └── open-next.config.ts       # opennextjs/cloudflare config
└── .github/
    └── workflows/
        └── deploy-web.yml        # CI: build + deploy Worker
```

## License

MIT
