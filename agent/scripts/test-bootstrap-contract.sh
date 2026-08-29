#!/usr/bin/env bash
# Deterministic contract tests for the fresh Invite Runtime bootstrap.
#
# The host-side bootstrap is documented in app/public/agent.md and copied into
# the Invite prompt. This test keeps that instruction contract synchronized
# with the canonical Go version source and the executable version query.
set -euo pipefail

cd "$(dirname "$0")/../.."

fail=0
note() { echo "bootstrap-contract: $1"; }

expect_text() {
  local name="$1" text="$2" file="$3"
  if grep -Fq "$text" "$file"; then
    note "PASS: $name"
  else
    note "FAIL: $name — missing '$text' in $file" >&2
    fail=1
  fi
}

source_version="$(sed -n 's/^var Version = "\([^"]*\)"$/\1/p' agent/internal/doctor/doctor.go)"
doc_version="$(sed -n 's/^`\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)` (release tag `agent-v[^`]*`).*/\1/p' app/public/agent.md | head -1)"

if [[ "$source_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  note "PASS: canonical version is stable semantic version"
else
  note "FAIL: canonical version is not a stable semantic version: '$source_version'" >&2
  fail=1
fi
if [ "$doc_version" = "$source_version" ]; then
  note "PASS: agent.md expected version matches canonical Go version"
else
  note "FAIL: agent.md version '$doc_version' does not match '$source_version'" >&2
  fail=1
fi

DOC=app/public/agent.md
expect_text "missing binary selects installer" 'command -v` fails' "$DOC"
expect_text "current binary is reused" 'exact expected version' "$DOC"
expect_text "stale binary selects installer" 'Older, newer, or otherwise different version' "$DOC"
expect_text "newer binary is not assumed compatible" 'newer, or otherwise different' "$DOC"
expect_text "malformed version fails closed" 'malformed/unparseable' "$DOC"
expect_text "installer result is version-verified" 'verify the installed version' "$DOC"
expect_text "wrong installer result cannot join" 'do not join or claim readiness' "$DOC"
expect_text "checksum remains mandatory" 'SHA256SUMS' "$DOC"
expect_text "official origin remains fixed" 'https://github.com/i365dev/free4chat/releases' "$DOC"
expect_text "explicit pin remains documented" 'FREE4CHAT_AGENT_VERSION=x.y.z' "$DOC"
expect_text "current binaries avoid reinstall" 'must not trigger the installer or another download' "$DOC"
expect_text "running process boundary remains explicit" 'does not replace an already-running old daemon' "$DOC"
expect_text "version query is the local check" 'free4chat-agent version --json' "$DOC"

join_line="$(grep -n '^   free4chat-agent join' "$DOC" | tail -1 | cut -d: -f1)"
verify_line="$(grep -n 'exactly equals the expected version above' "$DOC" | tail -1 | cut -d: -f1)"
if [ -n "$join_line" ] && [ -n "$verify_line" ] && [ "$verify_line" -lt "$join_line" ]; then
  note "PASS: version verification precedes join"
else
  note "FAIL: join is not ordered after installer version verification" >&2
  fail=1
fi

if grep -Fq 'If `free4chat-agent` is already available on `PATH`, run:' "$DOC"; then
  note "FAIL: old presence-only bootstrap shortcut remains" >&2
  fail=1
else
  note "PASS: presence-only bootstrap shortcut is absent"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-contract.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
(
  cd agent
  GOCACHE="$WORK/go-cache" go build -trimpath -o "$WORK/free4chat-agent" ./cmd/free4chat-agent
)
version_json="$(FREE4CHAT_AGENT_DIR="$WORK/runtime" "$WORK/free4chat-agent" version --json)"
if printf '%s\n' "$version_json" | grep -Fq "\"version\": \"$source_version\""; then
  note "PASS: version --json reports the canonical version"
else
  note "FAIL: version --json mismatch: $version_json" >&2
  fail=1
fi
if [ ! -e "$WORK/runtime" ]; then
  note "PASS: version --json does not start a daemon"
else
  note "FAIL: version --json touched the daemon runtime directory" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  note "FAILED"
  exit 1
fi
note "OK"
