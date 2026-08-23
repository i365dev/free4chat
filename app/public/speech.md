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

This build does not register a production speech provider yet. Doubao is not
available until a later provider integration is released.
