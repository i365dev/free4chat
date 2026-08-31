# Free4Chat Speech Capability Handoff

Speech configuration is local to the human's own `free4chat-agent` Runtime.
Free4Chat does not receive or store speech-provider credentials, raw audio, or
recordings. Committed Live Transcript text is bounded, Room-shared ephemeral
context and disappears with the Room's retention.

1. Run `free4chat-agent readiness --json` and inspect `speech.stt` /
   `speech.tts`: `configured` reports whether the credential is present and
   `ready` reports whether the capability is usable.
2. Never ask the human to paste a speech-provider credential into the room,
   model conversation, or an Agent-visible file.
3. If setup is needed, the Agent runs the official local command itself:

   `free4chat-agent credential provision --provider doubao --purpose speech.stt`

   On macOS it opens a Free4Chat-owned prompt with hidden input. The human
   enters the key only in that local prompt. The value is saved in macOS
   Keychain, never in a Room, Harness conversation, attachment, analytics,
   or new plaintext config file. The legacy `speech setup --provider doubao`
   terminal command remains for compatibility and also writes to Keychain.
   The human may alternatively provide `DOUBAO_API_KEY` on their own runtime
   process for headless Linux/automation. This version intentionally provides
   no Linux/Windows native keyring prompt. Legacy `credentials.json` is
   read-only compatibility input, except explicit `credential delete --provider
   doubao`, which removes its old Doubao API key to prevent fallback.
4. A successful provision asks an existing local daemon to reload speech for
   its resident Rooms; it does not require leaving or rejoining. After setup,
   run `free4chat-agent readiness --json` again. Claim readiness only when
   the requested slot reports `ready: true`. Cancellation or setup failure
   leaves ordinary text participation running.
5. Live Transcript authorization is separate from provider configuration. A
   configured provider does not grant room media access: a Human explicitly
   starts the Room-wide transcript through an authorized STT-ready Runtime
   Host, and any Human may stop it.
   In a Room, use **Connect local Runtime** to connect an already-running
   Runtime on this computer. The browser prepares a one-time local handoff
   command for you; it is not an Agent invitation and the opaque connection
   value should never be pasted into chat or a model conversation. After the
   Runtime connects, the Room shows **Local Runtime ready** and Start becomes
   available to that Human.
6. Cloud speech sends audio to the selected provider under the human's own
   provider account and credentials.
7. Raw audio is not intended to be persisted by Free4Chat.

Doubao Speech 2.0 is supported by the local Runtime for both capabilities:

- **Streaming ASR 2.0** — Room-wide Live Transcript media ingress
  (subscribe-only). Transcription is infrastructure; interpretation remains
  Agent work over the committed shared context.
- **Speech Synthesis 2.0 (TTS)** — outbound voice through the official V3
  output-unidirectional interface (`X-Api-Key`, resource id `seed-tts-2.0`,
  raw PCM s16le / 24 kHz / mono). The speaker is a 2.0 voice
  (`zh_female_shuangkuaisisi_uranus_bigtts` by default) and can be
  overridden locally with `DOUBAO_TTS_VOICE`.

One console credential powers both: configure it lazily with
`free4chat-agent credential provision --provider doubao --purpose speech.stt`
(macOS local prompt) or the `DOUBAO_API_KEY` environment variable on the
runtime process. The
provider uses the current X-API-Key protocol rather than legacy
AppId/AccessToken credentials. STT and TTS selections live in
separate config slots (`speech.stt.provider` / `speech.tts.provider` in the
runtime directory's `config.json`; override with `FREE4CHAT_STT_PROVIDER` /
`FREE4CHAT_TTS_PROVIDER`) and never displace each other.

When a human enables the room's voiceReply grant for an Agent, the resident
Runtime publishes synthesized replies over the shared Cloudflare SFU, making
them audible to room participants. This uses the configured Doubao Speech
Synthesis 2.0 provider and remains separate from the text-only MCP tools.
Without both the current room grant and local TTS configuration, voice output
is not activated.
