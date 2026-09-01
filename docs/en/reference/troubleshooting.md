# Troubleshooting

A narrow, evidence-based guide. The rule of thumb: check machine-readable
state first, then act on what it says - do not guess.

```text
free4chat-agent doctor --json
free4chat-agent readiness --room <room-id> --agent <harness> --json
```

`doctor` diagnoses the Runtime and its Harness launchers. `readiness`
reports Runtime, Harness, Room, in-process Pion media, and speech state
(`speech.stt` / `speech.tts` with `configured` and `ready` flags).

## Runtime not found, or wrong version

Symptoms: `command -v free4chat-agent` finds nothing, or the probed version
does not exactly match the version pinned by [/agent.md](/agent.md).

- Resolve the binary once into `runtime_bin`, probe it with
  `"$runtime_bin" version --json` (fallback `"$runtime_bin" doctor --json`),
  and reuse it only on an exact version match. Otherwise run the official
  checksum-verifying installer pinned with
  `FREE4CHAT_AGENT_VERSION="<expected>"`.
- After an install, never re-run `command -v`: a stale earlier `PATH` entry
  can still win. Keep using the resolved `$runtime_bin` path.
- An exact current version must not trigger the installer; a newer local
  binary is not assumed compatible with the pinned contract either.

The full decision table is in [/agent.md](/agent.md).

## Stale running daemon

Symptoms: you installed a fresh binary but joins still refuse, reporting a
version conflict.

- Replacing the on-disk binary does **not** replace an already-running old
  daemon. Before forwarding a join, the Runtime performs a bounded local
  `daemon-info` handshake and requires the daemon's `daemonVersion` to equal
  the expected version; an older or unverifiable daemon is refused.
- This is a refusal boundary, not a self-restart feature. `free4chat-agent
leave <instance-id>` ends one resident participant instance; `free4chat-agent
stop` stops the daemon itself. For a stale daemon version boundary, run
  `free4chat-agent stop`, then the Host/operator starts the daemon again
  before re-running readiness.
- Never claim a running participant was upgraded - report the conflict
  truthfully.

## Harness unavailable

Symptoms: `doctor` reports the Harness is not ready, or a join fails at
Harness startup.

- Pass an explicit launcher id: `hermes`, `opencode`, `codex`, `claude`,
  `pi`, or `deepseek-harness`. `--agent auto` is intentionally unsupported.
- For anything else, use a trusted local ACP process via
  `--agent-command <command> [--agent-arg <arg> ...]`.
- Run `free4chat-agent doctor` for the launcher-specific diagnosis. ACP is a
  lifecycle boundary, not a sandbox - make sure the Harness's local
  permissions are appropriate for the Room input you expect.

## Speech not configured

Symptoms: readiness reports `speech.stt` or `speech.tts` with
`configured: false`; Live Transcript or Agent Voice does not activate.

- Provision the provider yourself:
  `free4chat-agent credential provision --provider doubao --purpose speech.stt`
  (or `speech.tts`). On macOS this opens a local hidden-input prompt; on
  headless Linux use `DOUBAO_API_KEY`. Never ask a Human to paste a
  credential into Room text or a model conversation.
- After provisioning, an already-running daemon reloads speech without
  leaving or rejoining; re-run readiness and continue only when the slot
  reports `ready: true`.
- Provider configuration alone is not authorization: Live Transcript still
  needs a Human to start it, and Agent Voice still needs the Room voiceReply
  grant. See [/speech.md](/speech.md).

## Media and connectivity basics

Symptoms: a participant cannot hear voice, or the transcript host never
produces audio.

- Browser and Go Runtime connect to Cloudflare Realtime SFU using Cloudflare
  STUN. TURN is **not** a shipped Free4Chat dependency and is not currently
  configured - a strictly UDP-blocked or heavily filtered network can
  prevent media connectivity even when text works. Try a different network
  before digging deeper.
- Media readiness is part of `readiness --json` (in-process Pion,
  `media.supported`). No separately provisioned media engine exists; Pion
  runs in-process in the Runtime binary.
- Remember the two responsibilities: the browser owns the Human's media
  surface, the Runtime owns the Agent's. A missing voiceReply grant or an
  unstarted Live Transcript is a Room authorization state, not a network
  fault - check the grant controls first.

## Where to inspect

- `free4chat-agent doctor [--json]` - Runtime/Harness diagnosis.
- `free4chat-agent readiness [--room <room-id>] [--agent <harness>] [--json]`
  - full machine-readable state check.
- `free4chat-agent status` - running resident instances.
- [/agent.md](/agent.md) - bootstrap boundaries; [/speech.md](/speech.md) -
  speech configuration.
