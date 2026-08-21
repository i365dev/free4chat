# free4chat

[free4.chat](https://free4.chat/) — real-time voice + text chat. No sign-up, no server to run. Open a room and talk.

> ⚠️ Personal project / experimental. Use at your own risk.

## Features

- 🎙️ Voice chat in rooms
- 💬 Text chat with emoji
- 📎 File & image transfer (inline preview)
- 🖥️ Screen sharing
- 🤖 Luna — optional AI assistant (mention `@luna` to invoke)
- 🔒 No accounts, no persistent data
- ⏱️ Rooms automatically close after 2 hours
- 🛡️ Cloudflare Turnstile bot protection

## Privacy

free4chat is built around two principles: **no data outlives the conversation**, and **you don't need to trust any server**.

**What we don't store:**

- No accounts, no sign-up, no identity
- Files and images are transferred via WebRTC data channels, never written to any database
- Voice is relayed through Cloudflare's media nodes but never recorded

**What does persist (and why it's fine):**

- Room presence, recent text/action messages, and track metadata are held by a per-room Durable Object while the room is active. Rooms expire after two hours and the room state is deleted.
- When Luna AI is enabled, messages sent to `@luna` are transmitted to an external AI model (Cloudflare AI Gateway → `@cf/zai-org/glm-4.7-flash`) for processing. The last 20 messages of conversation context are retained in a Durable Object for the lifetime of the room session only. Luna is opt-in and disabled by default.
- Your nickname is saved in browser `localStorage` for convenience. Clear it anytime.

The Worker authenticates the room and coordinates presence; audio and screen sharing flow through Cloudflare's media plane, while files stay in browser-to-browser DataChannels.

## Tech Stack

| Layer    | Technology                                                                           |
| -------- | ------------------------------------------------------------------------------------ |
| Frontend | Next.js 15, Tailwind CSS                                                      |
| API      | Next.js API routes deployed as Cloudflare Worker via `@opennextjs/cloudflare`        |
| AI       | `BotSession` Durable Object → Cloudflare AI Gateway → `@cf/zai-org/glm-4.7-flash`   |
| Storage  | Cloudflare KV (room metadata, rate limiting) + DO KV storage (Luna chat history)     |
| Media    | Cloudflare Realtime SFU (WebRTC, audio, data channels, screen sharing)        |
| Security | Cloudflare Turnstile (full-page bot challenge) + origin whitelist + KV rate limiting |

## Stack History

This project has gone through three stacks, always with the same product goal:

| Branch                         | Stack                            | Why it changed                                                                    |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------- |
| [`golang`](../../tree/golang)  | Go + Pion WebRTC + coturn        | Self-hosted infra is too much overhead for a personal project                     |
| [`elixir`](../../tree/elixir)  | Elixir + Membrane Framework      | Maintaining a server cluster is still heavy for something this small              |
| **`cf-sfu`** (this branch) | Cloudflare Realtime SFU + Workers | Fully serverless — no servers to manage, private DataChannel transfers, free tier works |

The product never changed. The ops burden did.

The full story — WebRTC internals, why each stack was chosen, where AI voice bots are headed — is written up here: [**一个 WebRTC 聊天室的三次演进**](https://www.bmpi.dev/dev/free4chat/) (Chinese)

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local setup, deployment, and architecture notes.

## License

MIT
