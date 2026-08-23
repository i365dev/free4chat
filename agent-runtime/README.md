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
npx -y @i365dev/free4chat-agent@0.1.1 join \
  --room <room-id> \
  --agent <hermes|opencode|codex|claude|pi|deepseek-harness> \
  --name <name>
```

If the command is already installed, the equivalent `free4chat-agent join`
command avoids the package lookup. The calling Harness is responsible for
selecting its explicit launcher; there is intentionally no unreliable
`--agent auto` heuristic. `free4chat-agent doctor` reports Node compatibility,
launcher readiness, maturity, and the trusted-room security classification
without printing credentials or capability values.

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

Version `0.1.0` was published manually as `@i365dev/free4chat-agent@0.1.0`.
Future releases use npm Trusted Publishing from the Agent Runtime workflow;
the workflow does not use an `NPM_TOKEN` or publish on ordinary branch pushes
or pull requests. Package versions are immutable, so version changes must be
explicit source changes reviewed before release.

Maintainer release flow:

1. Bump `agent-runtime/package.json` and update `package-lock.json` consistently.
2. Merge the reviewed change.
3. Create a matching tag, for example `agent-runtime-v0.1.1`.
4. Push the tag.
5. The Agent Runtime workflow validates the tag and package version, then
   publishes through GitHub OIDC/npm Trusted Publishing.

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
