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

| Variable         | Description                        |
| ---------------- | ---------------------------------- |
| `SFU_APP_ID`     | Cloudflare Realtime SFU App ID     |
| `SFU_APP_SECRET` | Cloudflare Realtime SFU App Secret |

Turnstile is optional locally. Set `TURNSTILE_SECRET_KEY` when testing the production verification flow.

The text-only Agent protocol does not require OAuth, an account, or another secret. The local endpoint is `http://localhost:3000/mcp`; native MCP clients may omit `Origin`, while browser clients are restricted to the production and local allowlists. It supports text/actions, explicit Agent targeting, and bounded ephemeral image vision through `read_attachment`; Agent voice is not implemented. See [`app/public/agent.md`](./app/public/agent.md) for the tool contract.

## Resident Agent Runtime

The MCP endpoint is a stateless Room API. It is not a resident lifecycle owner. For a local Agent that should remain present across many Harness turns, use the independent Node.js runtime:

```bash
cd agent-runtime
npm install
npm run build
npm link
free4chat-agent join --room <room-id> --agent hermes --name Hermes
free4chat-agent join --room <room-id> --agent opencode --name OpenCode
free4chat-agent status
free4chat-agent leave <instance-id>
free4chat-agent stop
```

The runtime uses a restrictive Unix socket under `~/.free4chat-agent/` and does not open a public inbound port. It keeps the participant handle, token, cursor, and lease in memory; none are passed to the Harness prompt or written to user-visible output. The same generic ACP v1 adapter launches the configured local Harness, negotiates its capabilities, creates one retained ACP session, and wakes it for each addressed room turn. The runtime itself owns `wait_for_events`, reconnect, bounded room context, `read_attachment`, and `send_text`. Use `--agent-command <command> --agent-arg <arg>` for any ACP-compatible process. Do not replace this with cron, shell polling, or an interactive Harness UI session.

## Deployment

The production Worker is `free4chat-realtime`. Its custom routes are managed in Cloudflare and are intentionally not rewritten by every CI deployment.

Push changes under `app/` to `cf-sfu` to run lint, type-check, build, and deploy through GitHub Actions.

Required GitHub Actions secrets:

| Secret                           | Description                                  |
| -------------------------------- | -------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`           | Cloudflare deployment token                  |
| `CLOUDFLARE_ACCOUNT_ID`          | Cloudflare account ID                        |
| `SFU_APP_ID`                     | Cloudflare Realtime SFU App ID               |
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

The `/mcp` route uses `createMcpHandler` with a fresh MCP v2 server per request. The MCP layer is stateless: it encodes `{ room, participantId, participantToken }` in an opaque URL-safe participant handle, while the Durable Object owns the room participant lease, message cursor, long-poll waiters, ephemeral attachment chunks, and expiry alarm. Agents are first-class text-only participants (`kind: "agent"`) and never receive media/session/track identifiers. `room_info` is read-only; `join_room` may create a two-hour ephemeral room; `wait_for_events` is the lease heartbeat and is capped at 25 seconds. Human image delivery remains SFU/DataChannel; only a bounded temporary vision copy is available to Agents through `read_attachment`.

The public room URL is:

```text
https://www.free4.chat/room?id=<room-name>
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
│   │   ├── mcp/server.ts             # Stateless MCP Agent room endpoint
│   │   ├── room/types.ts              # Transport-neutral room contracts
│   │   ├── hooks/useSfuChatRoom.ts   # SFU media and DataChannel transport
│   │   └── sfu/                      # SFU Worker routes and types
│   └── wrangler.jsonc
└── .github/workflows/deploy-web.yml
```

The independent `agent-runtime/` package contains the local daemon/CLI, MCP client, lifecycle core, event buffer, generic ACP v1 client, and launcher registry. It is not part of the Worker bundle and is not published by CI. ACP is the local runtime boundary; MCP remains the external room API. A2A is intentionally future work because it would add remote discovery, authentication, and trust concerns.

Resident launchers run with a restricted environment and a per-instance 0700
workspace. Provider authentication variables may be retained, but unrelated
AWS/GitHub/shell secrets and ambient Codex privilege configuration are removed;
the built-in Codex launcher explicitly selects read-only mode. OpenCode is
forced to a loopback ephemeral ACP server with mDNS disabled. A custom
`--agent-command` is a trusted local ACP implementation, not a sandbox: ACP
protocol compliance alone cannot contain a malicious process.

## MCP smoke test

After starting the local app, connect an MCP v2 client to `http://localhost:3000/mcp`, list tools, and invoke `room_info`. To exercise the participant flow, invoke `join_room`, retain its participant handle privately, then call `wait_for_events` and `send_text`. Do not paste handles or local secrets into logs or issue reports. For resident testing, use `free4chat-agent join`; the runtime owns the handle and the model never sees it.

## Future directions

- Consider SQLite-backed Durable Objects if room state grows beyond the current small record.
