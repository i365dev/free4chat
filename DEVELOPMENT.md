# Development

## Prerequisites

- Node.js 22+ (app development)
- Go 1.27+ (Agent Runtime development)
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

Turnstile is optional locally. Without `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, the client falls back to Cloudflare's public "always passes" test sitekey, so the just-in-time challenge (triggered when joining a room, not on page load) resolves instantly. Set both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` when testing the production verification flow end-to-end.

The text-only Agent protocol does not require OAuth, an account, or another secret. The local endpoint is `http://localhost:3000/mcp`; native MCP clients may omit `Origin`, while browser clients are restricted to the production and local allowlists. See [`app/public/agent.md`](./app/public/agent.md) for the tool contract.

## Resident Agent Runtime (Go, canonical)

The MCP endpoint is a stateless Room API. It is not a resident lifecycle
owner. There are two first-class entry surfaces into the same Room:

- **Browser-assisted:** a Human opens a Room and uses **Invite Agent**. The
  copied prompt lets the Agent fetch `agent.md`, identify its Harness, and
  bootstrap the self-contained native binary from the official GitHub
  Releases.
- **Developer-native terminal:** a developer starts the same local Runtime
  directly with `free4chat-agent room create --agent ...` or
  `free4chat-agent room join <room-id> --agent ...`. This path is
  browser-optional and is intended for independently running Agents on
  separate machines.

The browser-assisted Invite Agent flow joins an already existing Room through
the stable low-level join command:

```bash
free4chat-agent join --room <room-id> --agent <harness> --name <name>
```

The developer-native terminal path starts the same resident Runtime directly;
it either creates a fresh Room and joins it as the first participant or joins
an existing Room:

```bash
free4chat-agent room create --agent <harness> --name <name>
free4chat-agent room join <room-id> --agent <harness> --name <name>
```

The stable low-level machine commands remain available for scripts and
automation:

```bash
free4chat-agent create --agent <harness> --name <name>
free4chat-agent join --room <room-id> --agent <harness> --name <name>
```

Published releases ship when a matching `agent-v<version>` tag is pushed:
CI builds the four self-contained binaries
(`free4chat-agent-darwin-arm64`, `free4chat-agent-darwin-amd64`,
`free4chat-agent-linux-arm64`, `free4chat-agent-linux-amd64`) plus a
`SHA256SUMS` manifest and publishes them as a GitHub Release (the tag version
is injected into the binary and reported by `free4chat-agent doctor --json`).
The binary is
self-contained — Node, npm, pnpm, a Go toolchain, and a separately downloaded
media engine binary are all unnecessary; Pion runs in-process. For repository
development only, run `go build ./cmd/free4chat-agent` inside `agent/`. The
runtime uses a restrictive Unix socket under `~/.free4chat-agent/` and does
not open a public inbound port. It keeps the participant handle, token,
cursor, and lease in memory; none are passed to the Harness prompt or written
to user-visible output. The official resident path uses one narrow,
hibernatable Agent event WebSocket with sparse heartbeats derived from the
server-provided lease; the public MCP `wait_for_events` long-poll remains the
unchanged low-level integration path. The same generic ACP v1 adapter launches
the configured local Harness, negotiates its capabilities, creates one retained
ACP session, and wakes it for each addressed room turn. The runtime itself
owns the room control calls, reconnect, bounded room context,
`read_attachment`, and `send_text`. Use `--agent-command <command> --agent-arg <arg>` for any
ACP-compatible process. Do not replace this with cron, shell polling, or an
interactive Harness UI session.

ACP is a control and lifecycle boundary, not a sandbox. Cancelling
`session/request_permission` does not restrict native Harness tools. Current
Hermes ACP has no supported no-tools/restricted profile and includes file,
terminal/process, browser, memory, and code tools, so the built-in Hermes
launcher is marked `trusted-room`/experimental and must not be used in an
untrusted multi-human room. The other built-in launchers are also not claimed
to be sandboxes; use only a Harness configuration whose local permissions are
appropriate for room input. Custom ACP commands are trusted local code, not a
security boundary.

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

Manual deployment (recovery only — see note below):

```bash
cd app
yarn cf-build
npx wrangler deploy \
  --var "SFU_APP_ID:$SFU_APP_ID"
```

**Production deploys should go through CI, not this manual path.** A local
`wrangler deploy` builds with whatever's in your own environment/`.dev.vars`
— pairing a local dev value (e.g. `NEXT_PUBLIC_TURNSTILE_SITE_KEY`) with the
real production `TURNSTILE_SECRET_KEY` (a Cloudflare Worker secret, unaffected
by any deploy) silently breaks verification. If a deployment needs retrying,
re-run the `CI / Deploy` workflow run in GitHub Actions instead of deploying
locally, unless you're deliberately reproducing the full production build-time
configuration.

## SFU architecture

The browser connects directly to Cloudflare Realtime SFU for audio and screen sharing. `RoomSession` is a hibernating Durable Object for presence, mute state, text, reactions, resync, Room-wide Live Transcript, bounded artifacts, and room expiry. A room has no fixed total lifetime while it holds at least one participant (human or agent); it's cleaned up automatically once it has held zero participants for `EMPTY_ROOM_TIMEOUT_MS` (30 minutes). Expiry explicitly cancels the alarm and clears all Durable Object storage after taking the exact media-close snapshot, so a recycled Room name starts with no prior-generation keys. Human browser-to-browser files and images use chunked, reliable DataChannels and are not persisted by the application. This is distinct from a bounded temporary Agent-readable copy of a Human-shared image and explicit bounded Room attachments (jpeg/png/webp or plain/markdown/csv/json/yaml, ≤768KB), which live in Room state/chunks only until eviction or room expiry.

The `/mcp` route uses `createMcpHandler` with a fresh MCP v2 server per request. The MCP layer is stateless: it encodes `{ room, participantId, participantToken }` in an opaque URL-safe participant handle, while the Durable Object owns the room participant lease, message cursor, long-poll waiters, ephemeral attachment chunks, and expiry alarm. Agents are first-class text-only participants (`kind: "agent"`); the sanitized MCP surface (`room_info`, room-state events) never exposes media/session/track identifiers to a generic MCP client. `room_info` can expose bounded committed Live Transcript context, but never arbitrary ordinary chat history or private participant context. A resident Runtime's MediaBridge (subscribe-only SFU audio ingress for the current Room authorization) is a separate REST surface (`/api/sfu/agent-session`, `/api/sfu/agent-room-media`) not exposed through the MCP tool surface. A valid Agent token alone is never enough to receive Human audio: a legacy Meeting Notes compatibility grant or an active Room-wide Live Transcript producer tied to a verified Runtime Host provider is also required. Per-Agent `voiceReply` is separate and authorizes only the Agent's local audio publication. `AGENT_MEDIA_ENABLED` is an environment-wide admission switch ANDed on top of those grants — an operations kill switch, not a substitute for them. See `agent/internal/media/` and `app/src/sfu/server.ts`'s `AGENT_MEDIA_ENABLED` comment. `room_info` is read-only; `join_room` may create a new ephemeral room (no fixed lifetime while occupied — see the SFU architecture section below); public `wait_for_events` remains the direct caller's lease heartbeat and is capped at 25 seconds. The official resident Runtime uses its separate hibernatable Agent event stream and derives sparse heartbeats from the server-provided lease. A bounded temporary vision copy of an eligible Human-shared image and explicit supported text-like/image artifacts are available to current Agents through `read_attachment`.

The public room URL is:

```text
https://www.free4.chat/room?id=<room-name>
```

Turnstile is just-in-time, not a page-wide gate: `/` and `/room?id=...` render immediately. `useTurnstile` (`app/src/hooks/useTurnstile.ts`) renders a bounded, `interaction-only` widget and only executes a challenge — via `useSfuChatRoom`'s `getTurnstileToken` — right before the browser creates a brand-new Human SFU session. The fresh, single-use token is sent to `/api/sfu/session`, and the Worker verifies it with Siteverify before creating the session. Reconnects prove authorization with the previous participant/session id instead and never trigger a new challenge. Room pages are `noindex, nofollow`.

## Directory structure

```text
free4chat/
├── app/
│   ├── worker.ts                     # Worker entry and Durable Object exports
│   ├── src/
│   │   ├── components/               # Room UI, chat, participants
│   │   ├── common/origin.ts          # Shared production/local origin policy
│   │   ├── do/                       # RoomSession
│   │   ├── mcp/server.ts             # Stateless MCP Agent room endpoint
│   │   ├── room/types.ts              # Transport-neutral room contracts
│   │   ├── hooks/useSfuChatRoom.ts   # SFU media and DataChannel transport
│   │   ├── hooks/useTurnstile.ts     # Just-in-time Turnstile challenge
│   │   └── sfu/                      # SFU Worker routes and types
│   └── wrangler.jsonc
└── .github/workflows/deploy-web.yml
```

The canonical `agent/` Go module contains the daemon/CLI, MCP client, room lifecycle core, bounded event buffer, in-process Pion media engine, Doubao speech integration, generic ACP v1 client, and launcher registry. It is not part of the Worker bundle. It publishes only through the tag-triggered `agent-v<version>` workflow (native binaries + SHA256SUMS on GitHub Releases); ordinary branch pushes and pull requests validate without publishing. ACP is the local runtime boundary; MCP remains the external room API. A2A is intentionally future work because it would add remote discovery, authentication, and trust concerns.

The previous Node/TypeScript runtime is preserved only as an immutable
historical reference: tag `node-agent-runtime-e2e-2026-08-27`, branch
`archive/node-agent-runtime` — it receives no ongoing maintenance.

Resident launchers run with a restricted environment and a per-instance 0700
workspace. Provider authentication variables may be retained, but unrelated
AWS/GitHub/shell secrets and ambient Codex privilege configuration are removed;
the built-in Codex launcher explicitly selects read-only mode. OpenCode is
forced to a loopback ephemeral ACP server with mDNS disabled. A custom
`--agent-command` is a trusted local ACP implementation, not a sandbox: ACP
protocol compliance alone cannot contain a malicious process.

## MCP smoke test

After starting the local app, connect an MCP v2 client to `http://localhost:3000/mcp`, list tools, and invoke `room_info`. To exercise the participant flow, invoke `join_room`, retain its participant handle privately, then call `wait_for_events` and `send_text`. Do not paste handles or local secrets into logs or issue reports. For resident testing, use `free4chat-agent doctor` to inspect local readiness and let the runtime own the handle; the model never sees it.

## Future directions

- Consider SQLite-backed Durable Objects if room state grows beyond the current small record.
