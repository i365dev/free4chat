# free4chat

[free4.chat](https://free4.chat/) is a real-time audio + text chat service. No sign-up, no server to run — just open a room and talk.

> ⚠️ Personal project / experimental. Use at your own risk.

## Why Cloudflare (branch history)

This project has gone through three stacks, always with the same product goal — a dead-simple, no-login voice + text room:

| Branch | Stack | Why it changed |
|---|---|---|
| [`golang`](../../tree/golang) | Go + Pion WebRTC + coturn | Self-hosted infra is too much overhead for a small personal project |
| [`elixir`](../../tree/elixir) | Elixir + Membrane Framework | Membrane eventually added file transfer support, but maintaining your own server cluster is still heavy for something this small |
| **`cloudflare`** (this branch) | Cloudflare RealtimeKit + Workers + Pages | Fully serverless — no servers to manage, file transfer built-in, free tier covers personal use |

The product never changed. The ops burden did.

## Features

- 🎙️ Voice chat in rooms
- 💬 Text chat with emoji
- 📎 File & image transfer (inline preview)
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
| Backend | Cloudflare Worker (token server, serverless) |
| Infra | Cloudflare Pages (frontend) + Cloudflare Workers (backend) |
| Media | Cloudflare RealtimeKit (WebRTC, audio/data channels) |

## Local Development

### Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A Cloudflare account with RealtimeKit enabled

### 1. Start the Worker (token server)

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in your credentials
npm run dev                       # starts on http://localhost:8787
```

Required values in `worker/.dev.vars`:

| Variable | Description |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token with Workers + RealtimeKit access |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID |
| `RTK_APP_ID` | RealtimeKit app ID |
| `RTK_PRESET_NAME` | Preset name configured in RealtimeKit dashboard |
| `ALLOWED_ORIGIN` | Allowed CORS origin (e.g. `http://localhost:3000`) |

Also set the KV namespace ID in `worker/wrangler.toml` (`id = "your-kv-namespace-id"`).

### 2. Start the Frontend

```bash
cd app
yarn install
cp .env.local.example .env.local  # NEXT_PUBLIC_WORKER_URL=http://localhost:8787
yarn dev                           # starts on http://localhost:3000
```

## Deployment

### Cloudflare Worker

Set these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`

Push to `cloudflare` branch with changes in `worker/` → auto-deploys via GitHub Actions.

### Cloudflare Pages

Set these GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `NEXT_PUBLIC_WORKER_URL` — your deployed worker URL (e.g. `https://free4chat-worker.<account>.workers.dev`)

Push to `cloudflare` branch with changes in `app/` → auto-deploys via GitHub Actions.

Set Worker runtime secrets via the Cloudflare dashboard or:

```bash
cd worker
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put RTK_APP_ID
npx wrangler secret put RTK_PRESET_NAME
npx wrangler secret put ALLOWED_ORIGIN
```

## Directory Structure

```
free4chat/
├── app/              # Next.js frontend
│   └── src/
│       ├── hooks/useChatRoom.ts     # core RealtimeKit hook
│       ├── components/              # UI components
│       └── pages/                   # Next.js pages
├── worker/           # Cloudflare Worker (token server)
│   └── src/index.ts                 # POST /api/token endpoint
└── .github/
    └── workflows/
        ├── deploy-worker.yml        # CI: deploy Worker
        └── deploy-pages.yml         # CI: deploy Pages
```

## License

MIT
