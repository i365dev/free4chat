# free4chat

[free4.chat](https://free4.chat/) is a real-time audio + text chat service. No sign-up, no server to run — just open a room and talk.

> ⚠️ Personal project, use at your own risk.

## Features

- 🎙️ Voice chat in rooms
- 💬 Text chat with emoji
- 📎 File & image transfer (inline preview)
- 🔒 No accounts, no persistent data

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
