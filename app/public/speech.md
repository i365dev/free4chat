# Free4Chat Speech Capability Contract

Speech capability belongs to a Human-controlled local `free4chat-agent`
Runtime. Provider credentials stay on that host. Free4Chat does not use speech
configuration as Room authorization.

## Security and data flow

- Never ask a Human to paste a speech-provider credential into Room text, a
  model conversation, an Agent-visible file, an attachment, or a shell
  argument.
- On macOS, the official provisioning flow stores the Doubao key in macOS
  Keychain under the local Free4Chat namespace.
- On headless Linux/automation hosts, use the local `DOUBAO_API_KEY`
  environment variable.
- Legacy `credentials.json` is read-only compatibility input. An explicit
  `credential delete --provider doubao` may remove its old Doubao API key to
  prevent fallback.
- Cloudflare Realtime SFU relays Room audio. When Live Transcript is enabled,
  the authorized local Runtime sends subscribed audio to the configured speech
  provider under the Human's own provider account.
- Free4Chat does not record Room audio. Committed Live Transcript text is
  bounded Room-shared ephemeral context and disappears with Room retention.

Provider configuration and Room authorization are separate:

```text
local provider ready != Room media grant
visibility != activation
transcription != interpretation
```

## Check readiness

Run:

```text
free4chat-agent readiness --json
```

For a specific Room/Harness:

```text
free4chat-agent readiness --room <room-id> --agent <harness> --json
```

Inspect `speech.stt` and `speech.tts`:

- `configured` reports whether the required local provider configuration is
  available.
- `ready` reports whether that capability is currently usable.

Claim readiness only when the requested slot reports `ready: true`.

## Configure Doubao locally

The supported Agent-triggerable provisioning command is:

```text
free4chat-agent credential provision --provider doubao --purpose speech.stt
```

`speech.tts` is also accepted as the purpose. One Doubao API key can power both
STT and TTS.

On macOS the command opens a Free4Chat-owned hidden-input prompt. The Human
enters the key only in that local prompt. The Harness receives only the bounded
command result and never the key.

The compatibility command remains available:

```text
free4chat-agent speech setup --provider doubao
```

It also stores the key in the native credential store.

On Linux/headless automation there is no native prompt. Configure
`DOUBAO_API_KEY` on the local Runtime process instead.

After successful provisioning, an already-running daemon receives a best-effort
speech reload request. Resident Rooms do not need to leave or rejoin. Re-run
readiness and continue only when the requested slot reports `ready: true`.
Cancellation or provisioning failure leaves ordinary text collaboration
running.

## Live Transcript

Live Transcript is Room-wide shared ephemeral context. STT authorization and
media orchestration are host-local, while transcription is performed by the
configured speech provider.

```text
Human authorizes one STT-ready Runtime Host
  -> Runtime subscribes to Room audio through Cloudflare Realtime SFU
  -> Runtime sends subscribed audio to Doubao ASR
  -> transcript text returns to the Runtime
  -> committed transcript becomes bounded Room-shared context
```

A configured provider does not grant media access. A Human explicitly starts
Live Transcript through an authorized STT-ready Runtime Host, and any Human may
stop it.

In the browser, **Connect local Runtime** connects an already-running Runtime
on the same computer. The browser prepares a one-time local handoff command.
That handoff value is not an Agent invitation and must not be pasted into Room
chat or a model conversation.

Seeing committed transcript context does not itself wake an Agent. Explicit
addressing controls Harness activation.

## Agent Voice

When a Human grants `voiceReply` for an Agent:

```text
Harness reply
  -> local Runtime
  -> Doubao TTS provider
  -> synthesized PCM back to the Runtime
  -> in-process Pion
  -> Cloudflare Realtime SFU
  -> Room participants
```

Voice output requires both:

1. a current Room `voiceReply` grant; and
2. local TTS readiness.

Without both, text collaboration continues but voice output is not activated.

## Supported provider

The local Runtime currently supports Doubao Speech 2.0:

- Streaming ASR 2.0 for Live Transcript media ingress.
- Speech Synthesis 2.0 for Agent Voice output through the V3
  output-unidirectional interface using `X-Api-Key`, resource id
  `seed-tts-2.0`, raw PCM s16le at 24 kHz mono.

The default TTS voice is:

```text
zh_female_shuangkuaisisi_uranus_bigtts
```

Override it locally with:

```text
DOUBAO_TTS_VOICE
```

STT and TTS provider selections remain separate configuration slots:

```text
speech.stt.provider
speech.tts.provider
```

They can also be overridden locally with:

```text
FREE4CHAT_STT_PROVIDER
FREE4CHAT_TTS_PROVIDER
```
