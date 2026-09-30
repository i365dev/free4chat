# Live Transcript

> For Runtime operators enabling local speech capability. Anyone in the Room
> sees the shared transcript once it is running.

Live Transcript turns Room audio into Room-wide shared text context. The
important boundaries: the transcript is produced by one Human-authorized,
STT-ready Runtime Host and its configured provider, and the transcript is
ephemeral shared context - not a meeting archive.

## How it works

One Human-authorized, STT-ready Runtime Host drives the transcript:

```text
Human authorizes one STT-ready Runtime Host
  -> Runtime subscribes to Room audio through Cloudflare Realtime SFU
  -> Runtime sends subscribed audio to the configured Doubao ASR provider
  -> transcript text returns to the Runtime
  -> committed transcript becomes bounded Room-shared context
```

Only one Runtime Host produces the transcript at a time, and it must be
STT-ready (a configured speech provider). Free4Chat does not record Room
audio; the authorized Runtime sends subscribed audio to the configured
speech provider under the Human's own provider account. The exact provider
and provisioning contract is [/speech.md](/speech.md).

## Starting and stopping

A configured provider alone grants nothing. Any Human in the Room can open
**Live Transcript**, select a connected STT-ready Runtime Host when there is
more than one, and click **Start**. That click authorizes the bounded Room
action; any Human may stop it. The Human starts transcription directly from
the connected STT-ready Runtime Host in the Room.

If no connected Runtime Host is transcription-ready, the panel explains
whether a Runtime needs to join the Room or needs local STT credentials and
configuration. Provider credentials remain on the Runtime.

## Transcript visibility never wakes an Agent

Committed transcript text is Room-shared context that every participant can
observe. It does not itself wake an Agent:

```text
visibility != activation
```

An Agent Harness only activates on explicit addressing - structured
`targetParticipantIds` metadata, never inferred from message text. So
participants can talk over Live Transcript without consuming an Agent's
attention; if you want an Agent to act on what was said, address it
explicitly. See [Shared context and artifacts](../concepts/shared-context).

Transcription is infrastructure, not interpretation: interpreting the
committed transcript remains Agent work over shared context.

## Not an archive

The committed transcript is bounded and ephemeral: it lives with the Room
and disappears when the Room expires. There is no permanent meeting record
and no transcript history on the Free4Chat side.

## Related pages

- [Agent Voice](agent-voice) - the outbound audio counterpart.
- [/speech.md](/speech.md) - the canonical speech capability contract.
