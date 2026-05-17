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
- 🛡️ Cloudflare Turnstile bot protection

## Privacy

free4chat is built around two principles: **no data outlives the conversation**, and **you don't need to trust any server**.

**What we don't store:**

- No accounts, no sign-up, no identity
- Messages exist only in participants' browser memory — close the tab and they're gone
- Files and images are transferred via WebRTC data channels, never written to any database
- Voice is relayed through Cloudflare's media nodes but never recorded

**What does persist (and why it's fine):**

- A `room name → meeting ID` mapping is kept in Cloudflare KV with a 30-day TTL so rejoining the same room name works. It contains no messages, no users, no content.
- When Luna AI is enabled, messages sent to `@luna` are transmitted to an external AI model (Cloudflare AI Gateway → `@cf/zai-org/glm-4.7-flash`) for processing. The last 20 messages of conversation context are retained in a Durable Object for the lifetime of the room session only. Luna is opt-in and disabled by default.
- Your nickname is saved in browser `localStorage` for convenience. Clear it anytime.

The Worker's only job is to issue a short-lived auth token — after that, all communication is peer-to-peer or via Cloudflare's media plane with no application-layer logging.

## Tech Stack

| Layer    | Technology                                                                           |
| -------- | ------------------------------------------------------------------------------------ |
| Frontend | Next.js 15, Tailwind CSS, Cloudflare RealtimeKit React SDK                           |
| API      | Next.js API routes deployed as Cloudflare Worker via `@opennextjs/cloudflare`        |
| AI       | `BotSession` Durable Object → Cloudflare AI Gateway → `@cf/zai-org/glm-4.7-flash`   |
| Storage  | Cloudflare KV (room metadata, rate limiting) + DO KV storage (Luna chat history)     |
| Media    | Cloudflare RealtimeKit (WebRTC, audio, data channels, screen sharing)                |
| Security | Cloudflare Turnstile (full-page bot challenge) + origin whitelist + KV rate limiting |

## Stack History

This project has gone through three stacks, always with the same product goal:

| Branch                         | Stack                            | Why it changed                                                                    |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------- |
| [`golang`](../../tree/golang)  | Go + Pion WebRTC + coturn        | Self-hosted infra is too much overhead for a personal project                     |
| [`elixir`](../../tree/elixir)  | Elixir + Membrane Framework      | Maintaining a server cluster is still heavy for something this small              |
| **`cloudflare`** (this branch) | Cloudflare RealtimeKit + Workers | Fully serverless — no servers to manage, file transfer built-in, free tier works  |

The product never changed. The ops burden did.

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local setup, deployment, and architecture notes.

## License

MIT
