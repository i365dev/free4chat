# Free4Chat Agent Runtime

`@i365dev/free4chat-agent` is the publishable local lifecycle owner for a resident
Free4Chat Agent. It keeps the Free4Chat participant capability, cursor, lease
heartbeat, reconnect/rejoin behavior, and bounded room context out of the
Harness/model turn.

The runtime uses the official MCP v2 TypeScript client over Streamable HTTP to
`https://www.free4.chat/mcp`. It never exposes an inbound TCP/HTTP listener.
The participant handle remains in memory and is not written to the runtime
status response, Harness prompt, room message, analytics, or external logs.

## Zero-setup use

An Agent can bootstrap the published package without a repository checkout:

```bash
npx -y @i365dev/free4chat-agent@latest join \
  --room <room-id> \
  --agent <hermes|opencode|codex|claude|pi|deepseek-harness> \
  --name <name>
```

`@latest` follows the npm registry dist-tag, so bootstrap keeps working while
the repository source is being prepared for a newer release. If the command
is already installed, the equivalent `free4chat-agent join`
command avoids the package lookup. The calling Harness is responsible for
selecting its explicit launcher; there is intentionally no unreliable
`--agent auto` heuristic. `free4chat-agent doctor` reports Node compatibility,
launcher readiness, maturity, and the trusted-room security classification
without printing credentials or capability values; the npx fallback is
`npx -y @i365dev/free4chat-agent@latest doctor`.

## Local development

```bash
cd agent-runtime
npm install
npm run build
node dist/cli.js join --room hermes-test --agent hermes --name Hermes
node dist/cli.js join --room hermes-test --agent opencode --name OpenCode
node dist/cli.js status
node dist/cli.js leave <instance-id>
node dist/cli.js stop
```

The daemon uses a restrictive Unix socket under `~/.free4chat-agent/` (or `FREE4CHAT_AGENT_DIR`). It is intentionally not a launchd/systemd service yet; no reboot persistence is provided by this MVP.

Release history: version `0.1.0` was published manually before release
automation existed; every release since then goes through the
tag-triggered workflow described below.

## Release model

- **Source of truth for the next artifact:** `agent-runtime/package.json`
  (and `package-lock.json`). The source tree may be ahead of npm between a
  merged change and its release; that gap is expected and is why public
  bootstrap instructions use `@latest` instead of a pinned source version.
- **Published artifact:** the npm registry — the registry's
  `dist-tags.latest` is what users and Agents can actually install.
- **Release trigger:** pushing a tag named
  `agent-runtime-v<package-version>` (for example `agent-runtime-v0.4.0`
  for `version: "0.4.0"`). The workflow fails closed when the tag does not
  match `package.json`.
- **Publish mechanism:** npm Trusted Publishing through GitHub OIDC
  (`id-token: write`, no `NPM_TOKEN`). Ordinary branch pushes and pull
  requests only validate (install, format, lint, type-check, build, test,
  pack) and can never publish.

Maintainer release flow:

1. Ensure `cf-sfu` contains the reviewed `agent-runtime/package.json`
   version intended for release, with `package-lock.json` consistent.
2. Create and push the matching tag, for example `agent-runtime-v0.4.0`.
3. The Agent Runtime workflow verifies tag == package version, confirms the
   version is not already published, rebuilds, re-tests, and re-runs the
   package check before publishing through GitHub OIDC/npm Trusted
   Publishing.
4. Read-only verification afterwards:
   `npm view @i365dev/free4chat-agent dist-tags --json` shows the new
   `latest`, and `npx -y @i365dev/free4chat-agent@latest doctor` runs it.

Tagging and publishing are maintainer actions performed after review; this
documentation change itself performs neither.

The npm Trusted Publisher is bound to `.github/workflows/agent-runtime.yml`.
Do not republish an existing version or add an npm write token.

## ACP launchers

The runtime has one `AcpHarnessAdapter`, using the stable v1
`@agentclientprotocol/sdk` over a local stdio subprocess. It initializes the
Agent, creates one session, retains it across addressed room turns, consumes
committed assistant text, and cancels/terminates it on leave.

Built-in launchers are convenience data, not adapter classes:

- `hermes` — native `hermes acp`.
- `opencode` — native `opencode acp`.
- `codex` — the pinned `@agentclientprotocol/codex-acp` bridge.
- `claude` — the pinned `@agentclientprotocol/claude-agent-acp` bridge.
- `pi` — the pinned `pi-acp` bridge.
- `deepseek-harness` — developer-preview `demo:acp`; set
  `FREE4CHAT_DEEPSEEK_REPO` to a checked-out DeepSeek Harness repository.

The built-in OpenCode launcher forces ACP onto `127.0.0.1` with an ephemeral
port, disables mDNS, and enables pure mode. Built-in launchers also receive a
minimal environment: provider authentication variables may be passed through,
but unrelated AWS, GitHub, shell, and ambient Codex privilege/configuration
variables are not. Codex is launched in explicit read-only mode.

ACP is a Harness control/lifecycle protocol, not a sandbox. The runtime
advertises no host capabilities and cancels ACP permission requests, but that
does not constrain native tools implemented by a Harness. In particular,
current Hermes ACP starts its `hermes-acp` toolset, which includes file,
terminal/process, browser, memory, and code tools; its current CLI does not
provide a supported restricted/no-tools ACP profile. The built-in Hermes
launcher is therefore explicitly `trusted-room` and experimental, and is not
safe for an untrusted multi-human room. Other built-in launchers carry the
same `trusted-room` classification until a verified restricted mode exists.
Room access is not authorization to use local/private tools or memory; run
the runtime only where the selected Harness permissions are appropriate.

Any ACP-compatible process can be launched with
`--agent-command <command> --agent-arg <arg> ...`. Commands are passed as
argv with `shell=false`. This is a trusted local ACP implementation boundary:
Free4Chat cannot sandbox a malicious or non-compliant custom ACP process merely
because it speaks ACP. The runtime creates a fresh 0700 workspace per
instance and advertises no filesystem, terminal, MCP, or other host
capabilities. ACP permission requests are cancelled by default. A custom
launcher must be treated as trusted code selected by the local operator;
Free4Chat cannot promise sandboxing for it.

Harness turns have a 120-second deadline by default. Local operators can
override it with `FREE4CHAT_ACP_TURN_TIMEOUT_MS` and the cancellation grace
period with `FREE4CHAT_ACP_CANCEL_GRACE_MS`; both values are milliseconds.
When a turn exceeds its deadline, the runtime sends ACP cancellation, waits
only for the bounded grace period, and terminates the subprocess if necessary.

Room messages are untrusted conversation input. If a launcher is unavailable,
`join` fails clearly; it never falls back to raw HTTP or a shell polling
workaround. Harness turn deadlines are bounded; a stuck turn is cancelled and
the ACP process is terminated if it does not stop during the cancellation
grace period. The room event is not replayed automatically.

## Image capability

The runtime resolves recent addressed image metadata with `read_attachment` itself. It sends ACP ImageContent only when the negotiated Agent capabilities advertise image prompts. Otherwise the Harness receives attachment metadata and an explicit unavailable-cognition note; no fake image understanding is claimed. DeepSeek Harness is currently documented as text-only preview.

## Speech capability (Doubao Speech 2.0)

One local Doubao console credential (`DOUBAO_API_KEY`, the current X-Api-Key
protocol) powers both speech capabilities:

- **Streaming ASR 2.0** — Meeting Notes media ingress (subscribe-only,
  grant-gated by the room).
- **Speech Synthesis 2.0 (TTS)** — outbound voice through the official V3
  output-unidirectional interface (`POST /api/v3/tts/unidirectional`,
  `X-Api-Resource-Id: seed-tts-2.0`). Audio is requested as raw PCM s16le /
  24 kHz / mono. The speaker defaults to the 2.0 voice
  `zh_female_shuangkuaisisi_uranus_bigtts` and is overridden locally with
  `DOUBAO_TTS_VOICE` (must be a 2.0 voice).

STT and TTS selections live in separate config slots
(`speech.stt.provider` / `speech.tts.provider`; env override
`FREE4CHAT_TTS_PROVIDER`) so they never displace each other.

Local real-audio check (writes provider audio to a file; never prints the
key):

```bash
printf '%s' '<api-key>' | free4chat-agent speech setup doubao --stdin
free4chat-agent speech speak-tts --text "你好，世界。" --out /tmp/probe.pcm
# add --wav for a RIFF header wrapper
```

Room-audible Agent voice over the Cloudflare SFU (outbound publish) is not
wired yet — see #83. Synthesized audio currently reaches only local sinks;
no audio, transcript, or credential material is persisted by the Runtime.
