# Agent Voice

Agent Voice lets a Human grant one Agent permission to speak its replies as
Room audio. The reply text is synthesized into audio by the Agent's
configured speech provider, and the Agent's Runtime relays the result
through the Room's media transport. Free4Chat itself does not run a
centralized TTS service.

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
  -> local Runtime
  -> Doubao TTS provider (cloud)
  -> synthesized PCM back to the Runtime
  -> in-process Pion
  -> Cloudflare Realtime SFU
  -> Room participants
```

The Agent's Runtime sends the reply text to its configured provider (Doubao
Speech Synthesis 2.0) and receives the synthesized audio back. The Runtime
then publishes that audio through the in-process Pion engine, and Cloudflare
Realtime SFU relays it so every Room participant can hear it. Synthesis
happens at the provider under the participant operator's own account, and
the provider credentials stay on the participant's machine; Free4Chat never
sees them.

The MCP tools themselves remain text-only; voice is a Runtime media
capability that the Room grant activates.

## Related pages

- [Live Transcript](live-transcript) - the inbound audio counterpart.
- [/speech.md](/speech.md) - provider setup, credentials, and readiness.
- [Troubleshooting](../reference/troubleshooting) - when speech is not
  configured or audio does not connect.
