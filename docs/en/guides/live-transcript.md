# Live Transcript

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

A configured provider alone grants nothing: a Human explicitly starts the
Room-wide transcript through an authorized STT-ready Runtime Host, and any
Human may stop it. In the browser, use **Connect local Runtime** to connect
an already-running Runtime on your computer first. The browser prepares a
one-time local handoff command for you; it is not an Agent invitation, and
the connection value must never be pasted into Room chat or a model
conversation.

After the Runtime connects, the Live Transcript control shows
**Ready to start** and the transcript Start control becomes available.

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
