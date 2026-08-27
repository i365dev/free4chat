# Free4Chat Speech Capability Handoff

Speech configuration is local to the human's own `free4chat-agent` Runtime.
Free4Chat does not receive or store speech-provider credentials, transcripts, or
recordings.

1. Run `free4chat-agent speech status --json` and inspect the requested
   capability and provider.
2. Never ask the human to paste a speech-provider credential into the room,
   model conversation, or an Agent-visible file.
3. If setup is needed, tell the human to run the exact local command
   `free4chat-agent speech setup <provider>`.
4. After setup, run `free4chat-agent speech doctor --json`. Claim readiness
   only when doctor reports `ready: true`.
5. Meeting Notes room consent and authorization are separate from provider
   configuration. A configured provider does not grant room media access.
6. Cloud speech sends audio to the selected provider under the human's own
   provider account and credentials.
7. Raw audio is not intended to be persisted by Free4Chat.

Doubao Speech 2.0 is supported by the local Runtime for both capabilities:

- **Streaming ASR 2.0** — Meeting Notes media ingress (subscribe-only).
- **Speech Synthesis 2.0 (TTS)** — outbound voice through the official V3
  output-unidirectional interface (`X-Api-Key`, resource id `seed-tts-2.0`,
  raw PCM s16le / 24 kHz / mono). The speaker is a 2.0 voice
  (`zh_female_shuangkuaisisi_uranus_bigtts` by default) and can be
  overridden locally with `DOUBAO_TTS_VOICE`.

One console credential powers both: configure it with
`free4chat-agent speech setup doubao`; the setup command performs a live
authenticated readiness check before saving the local API key. The required
environment override is `DOUBAO_API_KEY`, and the provider uses the current
X-API-Key protocol rather than legacy AppId/AccessToken credentials. STT and
TTS selections live in separate config slots
(`speech.stt.provider` / `speech.tts.provider`; override with
`FREE4CHAT_TTS_PROVIDER`) and never displace each other.

When a human enables the room's voiceReply grant for an Agent, the resident
Runtime publishes synthesized replies over the shared Cloudflare SFU, making
them audible to room participants. This uses the configured Doubao Speech
Synthesis 2.0 provider and remains separate from the text-only MCP tools.
Without both the current room grant and local TTS configuration, voice output
is not activated. The local test entry point
(`free4chat-agent speech speak-tts --text "..." --out out.pcm [--wav]`)
remains available for checking provider audio without printing the key.
