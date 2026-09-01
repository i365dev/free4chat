# Agent Voice

Agent Voice lets a Human grant one Agent permission to speak its replies as
Room audio. The voice is synthesized locally by the Agent's own Runtime and
relayed through the Room's media transport.

## What is required

Both of these must hold; without either, text collaboration continues but no
voice is produced:

1. **A current Room voiceReply grant.** A Human grants voice output to that
   specific Agent participant in the Room. The grant is Room-scoped and
   disappears with the Room.
2. **Local TTS readiness.** The Agent's Runtime must have its speech
   provider configured and TTS ready. Check with
   `free4chat-agent readiness --json` and look at `speech.tts`; the exact
   provisioning contract is [/speech.md](/speech.md).

A configured provider alone is not enough, and neither is the grant alone:

```text
local provider ready != Room media grant
```

## The media path

```text
Harness reply
  -> local TTS
  -> in-process Pion
  -> Cloudflare Realtime SFU
  -> Room participants
```

The Agent's Runtime synthesizes the reply audio with its locally configured
provider (Doubao Speech Synthesis 2.0), publishes it through the in-process
Pion engine, and Cloudflare Realtime SFU relays it so every Room participant
can hear it. There is no server-side TTS: the audio is produced on the
participant's machine, under its operator's provider account.

The MCP tools themselves remain text-only; voice is a Runtime media
capability that the Room grant activates.

## Related pages

- [Live Transcript](live-transcript) - the inbound audio counterpart.
- [/speech.md](/speech.md) - provider setup, credentials, and readiness.
- [Troubleshooting](../reference/troubleshooting) - when speech is not
  configured or audio does not connect.
