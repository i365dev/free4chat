# free4chat

[www.free4.chat](https://www.free4.chat/) — real-time voice + text chat. No sign-up, no server to run. Open a room and talk.

> ⚠️ Personal project / experimental. Use at your own risk.

## Features

- 🎙️ Voice chat in rooms
- 💬 Text chat with emoji
- 📎 File & image transfer (inline preview)
- 🖥️ Screen sharing
- 🔒 No accounts, no persistent data
- ⏱️ Rooms automatically close after 2 hours
- 🛡️ Cloudflare Turnstile bot protection
- 🤖 Text-only Agent rooms through stateless MCP
- 🧩 Optional local resident Agent Runtime for persistent Harness presence

## Privacy

free4chat is built around two principles: **no data outlives the conversation**, and **you don't need to trust any server**.

**What we don't store:**

- No accounts, no sign-up, no identity
- Files and images are transferred via WebRTC data channels, never written to any database
- Voice is relayed through Cloudflare's media nodes but never recorded

**What does persist (and why it's fine):**

- Room presence, recent text/action messages, and track metadata are held by a per-room Durable Object while the room is active. Rooms expire after two hours and the room state is deleted.
- Your nickname is saved in browser `localStorage` for convenience. Clear it anytime.

The Worker authenticates the room and coordinates presence; audio and screen sharing flow through Cloudflare's media plane, while human files stay in browser-to-browser DataChannels. Text-only Agents can join through the stateless [`/mcp`](https://www.free4.chat/mcp) endpoint, observe room context, receive explicit `@Agent` addressing metadata, and read bounded ephemeral image copies through `read_attachment`. For resident participation, the optional local [`agent-runtime/`](./agent-runtime/) owns the participant lease and wakes a supported Hermes, Codex, Claude, or Pi Harness turn. Agent voice is not implemented. Agent room access is a room capability only: it does not expose local files, shell commands, or any tools on the Agent host. See [`app/public/agent.md`](./app/public/agent.md) for the machine-readable protocol.

## Tech Stack

| Layer    | Technology                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Frontend | Next.js 15, Tailwind CSS                                                                                    |
| API      | Next.js API routes deployed as Cloudflare Worker via `@opennextjs/cloudflare`                               |
| Storage  | Cloudflare KV (room metadata, rate limiting) + per-room Durable Object state                                |
| Media    | Cloudflare Realtime SFU (WebRTC, audio, data channels, screen sharing)                                      |
| Agents   | Stateless MCP v2 Room API + optional local Free4Chat Agent Runtime with Hermes/Codex/Claude/Pi adapters |
| Security | Cloudflare Turnstile (full-page bot challenge) + origin whitelist + KV rate limiting                        |

## Stack History

This project has gone through four stacks, always with the same product goal:

| Branch                                | Stack                             | Why it changed                                                                                                                                     |
| ------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`golang`](../../tree/golang)         | Go + Pion WebRTC + coturn         | Self-hosted infra is too much overhead for a personal project                                                                                      |
| [`elixir`](../../tree/elixir)         | Elixir + Membrane Framework       | Maintaining a server cluster is still heavy for something this small                                                                               |
| [`cloudflare`](../../tree/cloudflare) | Cloudflare Workers + RealtimeKit  | A managed-media experiment; participant-minute pricing was too expensive, and the higher-level API limited advanced features and low-level control |
| **`cf-sfu`** (this branch)            | Cloudflare Realtime SFU + Workers | Replaced RealtimeKit with the lower-level SFU — fully serverless, private DataChannel transfers, and direct control over media features            |

The product never changed. The ops burden did.

The full story — WebRTC internals, why each stack was chosen, where AI voice bots are headed — is written up here: [**一个 WebRTC 聊天室的三次演进**](https://www.bmpi.dev/dev/free4chat/) (Chinese)

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local setup, deployment, and architecture notes.

## License

MIT
