# Node Agent Runtime Reference

## Status

The Node/TypeScript Agent Runtime is the final proven pre-Go implementation.
It is frozen as a behavioral and architectural reference, not an alternative
supported runtime. It receives no ongoing feature maintenance. The canonical
runtime is now the self-contained native Go implementation from issue #128
(`agent/`); the frozen Node baseline remains the behavioral oracle for the
rewrite.

- Frozen tag: `node-agent-runtime-e2e-2026-08-27`
- Archive branch: `archive/node-agent-runtime`
- Exact SHA: `ef98b12e863a705c1d895550004158cc0e92a284`

## Reference architecture

```text
Node/TypeScript Agent Runtime
          |
          | JSONL stdio
          v
      Go/Pion media process
          |
          v
  Cloudflare Realtime SFU
```

Node owns CLI and daemon lifecycle, MCP and room lifecycle, Harness/ACP
orchestration, attachments and collaboration, Meeting Notes and TTS
orchestration, diagnostics, and local state.

Go/Pion owns the WebRTC PeerConnection, DataChannel and media transport, RTP,
Opus, PCM framing/resampling, and SFU media publish/subscribe mechanics.

## Proven E2E baselines

Meeting Notes:

```text
Human browser -> Cloudflare SFU -> shared Pion -> ontrack / Human RTP -> STT
-> Meeting Notes result
```

Voice Reply:

```text
addressed Human turn -> Runtime VoiceOutput -> TTS -> PCM -> Pion Opus
-> Cloudflare publisher active -> RoomSession track publication
-> Human trackPublished -> Human remote subscription
-> SFU offer/answer/renegotiate -> browser ontrack -> MediaStream
-> audible audio
```

The final Voice validation explicitly confirmed audible playback in the Human
browser, not merely signaling or DOM state.

## Rewrite usage

Use this frozen implementation as a behavioral oracle for text room lifecycle,
Harness/ACP behavior, attachments and collaboration, Meeting Notes, Voice
Reply, revocation and cleanup, diagnostics, and security invariants. For
example:

```bash
git show node-agent-runtime-e2e-2026-08-27:agent-runtime/...
git diff node-agent-runtime-e2e-2026-08-27..<go-rewrite-ref>
```

The Go rewrite does not need to preserve the TypeScript architecture.

## Maintenance policy

The archive is immutable and reference-only. Do not sync server changes into
it, fix bugs there, maintain Node/Go feature parity, or run it as a second
canonical production runtime. If Go exposes a discrepancy, first determine
whether Go violates the intended product invariant or the old Node behavior
was incidental.
