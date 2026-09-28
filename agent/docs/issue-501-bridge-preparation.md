# Issue #501 bridge preparation architecture

## Current path

Codex (`@agentclientprotocol/codex-acp@1.12.0`), Claude (`@agentclientprotocol/claude-agent-acp@0.70.0`), and Pi (`pi-acp@0.0.33`) are all registry entries that launch `npx -y <pinned-package>`. `BuildAdapter` allocates lazy ACP adapters; `ACPAdapter.EnsureSession` starts the configured command before the existing initialize/session control flow. Child stderr is discarded and preparation/start errors currently collapse into generic materialization failures. Doctor runs `<launcher> --version`; for bridge entries it marks `npx` availability as `ready` and says the package installs on first join.

The daemon's canonical data root is `RuntimeDirectory()`: `FREE4CHAT_AGENT_DIR` when set, otherwise `~/.free4chat-agent`. The current release baseline is `free4chat-agent 0.5.44` (source tip `b6b06d19`, which records that release in PR #500). Normal ACP control requests remain bounded at 20 seconds.

## Chosen design

- Provider registry metadata owns each bridge's exact npm package, version, and bin name. Native and custom launchers are unchanged.
- The shared cache is `<RuntimeDirectory>/bridges/<package>/<version>`. Installation uses `npm install --prefix <unique-staging-prefix> --no-audit --no-fund <package>@<version>` under a bounded context.
- Validate the staged package manifest's exact version and bin mapping, then atomically rename the complete staging prefix into the versioned cache. Concurrent preparers may install independently; only one promotion wins, and losers validate/reuse the winner. Partial directories are never promoted.
- Resolve the provider's declared bin entry from the installed manifest and execute it with `node`, avoiding platform-specific npm `.bin` shims. Missing/corrupt caches are rebuilt lazily; no global install, `_npx` dependency, automatic retry loop, or cache GC is added.
- Doctor reports Node as the launch prerequisite, while `ready` means the pinned bridge is already validated in the Runtime cache. A cold bridge is reported as available with a first-join preparation note; if npm is missing, doctor says preparation cannot run. Doctor does not access the network.
- Preparation failures and child-start/ACP-handshake failures use bounded stable diagnostic classes. Child stderr and npm configuration are not exposed. The existing 20-second ACP control timeout is unchanged.

## Scope

One shared preparation path covers Codex, Claude, and Pi from the provider registry. Hermes and OpenCode native launchers, session/concurrency policy, ACP continuation behavior, and release tooling are outside this change.
