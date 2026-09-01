#!/usr/bin/env bash
# Distribution/cleanup contract check (PR3).
#
# Asserts that the canonical tree has exactly one supported Agent runtime
# (the self-contained Go binary), that the obsolete Node runtime and its
# npm/Pion-provisioning machinery are gone, that the official installer
# exists and is syntactically valid, and that the immutable historical
# references required by issue #128 are still present.
set -euo pipefail

cd "$(dirname "$0")/../.."
fail=0

note() { echo "cleanup-check: $1"; }

# Canonical user-facing docs must no longer reference the removed npm
# runtime as an installable bootstrap path.
for file in \
  README.md \
  DEVELOPMENT.md \
  AGENTS.md \
  app/public/agent.md \
  app/src/pages/ai-agent-room.tsx; do
  # Patterns are written with character classes so this contract file does
  # not itself trip repository-wide grep gates for the retired runtime.
  if grep -nE "@i365dev[/]free4chat-agent|agent-runtime[-]v|npx -y @i365de[v]" "$file" >/dev/null 2>&1; then
    note "stale npm runtime reference in $file" >&2
    fail=1
  fi
done

# The Node runtime tree and its release/provisioning workflows are gone.
if [ -d agent-runtime ]; then
  note "agent-runtime/ must be removed" >&2
  fail=1
fi
for path in \
  .github/workflows/agent-runtime.yml \
  .github/workflows/pion-binaries.yml \
  .github/workflows/pion-engine.yml \
  scripts/media-e2e-preflight.sh; do
  if [ -e "$path" ]; then
    note "$path must be removed" >&2
    fail=1
  fi
done

# The canonical Go runtime and its native distribution path exist.
if [ ! -d agent ]; then
  note "agent/ (canonical Go runtime) missing" >&2
  fail=1
fi
if [ ! -x agent/scripts/release.sh ]; then
  note "agent/scripts/release.sh missing or not executable" >&2
  fail=1
fi
if [ ! -f .github/workflows/agent-release.yml ]; then
  note ".github/workflows/agent-release.yml missing" >&2
  fail=1
fi
if [ ! -f app/public/install-agent.sh ]; then
  note "app/public/install-agent.sh missing" >&2
  fail=1
elif ! bash -n app/public/install-agent.sh; then
  note "app/public/install-agent.sh failed bash -n" >&2
  fail=1
fi

# The obsolete Pion sidecar experiment must not return to the canonical tree.
if [ -d experiments/pion-cloudflare ]; then
  note "experiments/pion-cloudflare/ must remain removed" >&2
  fail=1
fi
# The frozen tag/archive branch are documented by this immutable reference.
if [ ! -f docs/agent-runtime/node-reference.md ]; then
  note "docs/agent-runtime/node-reference.md must be preserved" >&2
  fail=1
fi

# The Go runtime is self-contained: no Node-era provisioning glue remains
# inside the canonical runtime code (distribution scripts are excluded —
# they contain the search patterns themselves).
if grep -rn --exclude-dir=scripts "pionProvision\|provisionPion\|ensurePionBinary\|FREE4CHAT_PION[_]BIN\|FREE4CHAT_MEDIA[_]ENGINE\|--agent-command npx\|npx -y @i365de[v]\|dist/cli[.]js" agent/ >/dev/null 2>&1; then
  note "stale Node-era provisioning references inside agent/" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  note "FAILED" >&2
  exit 1
fi
note "OK"
