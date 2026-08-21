# Development

## Prerequisites

- Node.js 22+
- A Cloudflare account with Realtime SFU enabled
- A Cloudflare Realtime SFU App ID and App Secret

## Local setup

```bash
cd app
yarn install
cp .dev.vars.example .dev.vars
yarn dev
```

Required local values are documented in `app/.dev.vars.example`:

| Variable | Description |
| --- | --- |
| `SFU_APP_ID` | Cloudflare Realtime SFU App ID |
| `SFU_APP_SECRET` | Cloudflare Realtime SFU App Secret |

Turnstile is optional locally. Set `TURNSTILE_SECRET_KEY` when testing the production verification flow.

## Deployment

The production Worker is `free4chat-realtime`. Its custom routes are managed in Cloudflare and are intentionally not rewritten by every CI deployment.

Push changes under `app/` to `cf-sfu` to run lint, type-check, build, and deploy through GitHub Actions.

Required GitHub Actions secrets:

| Secret | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare deployment token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `SFU_APP_ID` | Cloudflare Realtime SFU App ID |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Public Turnstile site key used at build time |

Worker runtime secrets are stored in Cloudflare, not git:

```bash
cd app
npx wrangler secret put SFU_APP_SECRET
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Manual deployment:

```bash
cd app
yarn cf-build
npx wrangler deploy \
  --var "SFU_APP_ID:$SFU_APP_ID"
```

## SFU architecture

The browser connects directly to Cloudflare Realtime SFU for audio and screen sharing. `RoomSession` is a hibernating Durable Object for presence, mute state, text, reactions, resync, and room expiry. Files and images use chunked, reliable DataChannels and are never persisted by the application.

The public room URL is:

```text
https://free4.chat/room?id=<room-name>
```

`TurnstileGate` wraps the app in `_app.tsx`. The browser sends its session token to `/api/sfu/session`, and the Worker verifies it before creating an SFU session.

## Directory structure

```text
free4chat/
├── app/
│   ├── worker.ts                     # Worker entry and Durable Object exports
│   ├── src/
│   │   ├── components/               # Room UI, chat, Turnstile, participants
│   │   ├── common/origin.ts          # Shared production/local origin policy
│   │   ├── do/                       # RoomSession
│   │   ├── hooks/useSfuChatRoom.ts   # SFU media and DataChannel transport
│   │   └── sfu/                      # SFU Worker routes and types
│   └── wrangler.jsonc
└── .github/workflows/deploy-web.yml
```

## Future directions

- Consider SQLite-backed Durable Objects if room state grows beyond the current small record.
