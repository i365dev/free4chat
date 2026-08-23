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

Doubao Streaming ASR 2.0 is supported by the local Runtime. Configure it with
`free4chat-agent speech setup doubao`; the setup command performs a live
authenticated readiness check before saving the local API key. The required
environment override is `DOUBAO_API_KEY`, and the provider uses the current
X-API-Key protocol rather than legacy AppId/AccessToken credentials.
