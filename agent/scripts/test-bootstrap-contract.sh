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
expect_text "published old releases have a fallback" 'fall back to' "$DOC"
expect_text "doctor is the compatibility fallback" 'free4chat-agent doctor --json' "$DOC"
expect_text "both probes must fail before fail-closed install" 'both commands fail' "$DOC"

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

# Exercise the exact compatibility path used for the published v0.5.4
# binary: the new fast path is unsupported, but doctor --json is valid.
extract_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' |
    head -1
}

is_stable_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

probe_runtime_version() {
  local binary="$1" output version
  output="$("$binary" version --json 2>/dev/null)" || output=""
  version="$(printf '%s\n' "$output" | extract_version)"
  if [ -n "$version" ] && is_stable_version "$version"; then
    printf '%s\n' "$version"
    return 0
  fi
  output="$("$binary" doctor --json 2>/dev/null)" || output=""
  version="$(printf '%s\n' "$output" | extract_version)"
  if [ -n "$version" ] && is_stable_version "$version"; then
    printf '%s\n' "$version"
    return 0
  fi
  return 1
}

bootstrap_action() {
  local binary="$1" expected="$2" installed
  if [ ! -x "$binary" ]; then
    printf '%s\n' install
    return 0
  fi
  installed="$(probe_runtime_version "$binary")" || installed=""
  if [ "$installed" = "$expected" ]; then
    printf '%s\n' reuse
  else
    printf '%s\n' install
  fi
}

write_fake_agent() {
  local path="$1" fast_path="$2" doctor_version="$3"
  cat > "$path" <<EOF
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "version --json")
    $fast_path
    ;;
  "doctor --json")
    printf '{"version":"$doctor_version"}\n'
    ;;
  *)
    exit 2
    ;;
esac
EOF
  chmod +x "$path"
}

write_fake_agent "$WORK/published-v0.5.4" 'echo unsupported >&2; exit 2' "$source_version"
write_fake_agent "$WORK/stale-contract" 'echo unsupported >&2; exit 2' "0.5.3"
write_fake_agent "$WORK/newer-contract" 'printf "%s\\n" "{\\"version\\":\\"0.5.5\\"}"' "0.5.5"
write_fake_agent "$WORK/malformed-contract" 'echo not-json; exit 0' "not-a-version"
write_fake_agent "$WORK/wrong-after-install" 'echo unsupported >&2; exit 2' "0.5.3"

if [ "$(bootstrap_action "$WORK/published-v0.5.4" "$source_version")" = reuse ] &&
  [ "$(probe_runtime_version "$WORK/published-v0.5.4")" = "$source_version" ]; then
  note "PASS: published old-contract binary reuses via doctor fallback"
else
  note "FAIL: published old-contract binary did not reuse via doctor fallback" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/free4chat-agent" "$source_version")" = reuse ]; then
  note "PASS: new exact-version binary reuses via fast path"
else
  note "FAIL: new exact-version binary did not reuse" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/stale-contract" "$source_version")" = install ]; then
  note "PASS: older old-contract binary selects installer"
else
  note "FAIL: older old-contract binary bypassed installer" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/newer-contract" "$source_version")" = install ]; then
  note "PASS: newer binary selects installer"
else
  note "FAIL: newer binary was silently accepted" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/malformed-contract" "$source_version")" = install ]; then
  note "PASS: malformed probes fail closed"
else
  note "FAIL: malformed probes were silently accepted" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/missing-agent" "$source_version")" = install ]; then
  note "PASS: missing binary selects installer"
else
  note "FAIL: missing binary did not select installer" >&2
  fail=1
fi
if [ "$(probe_runtime_version "$WORK/wrong-after-install" 2>/dev/null)" != "$source_version" ]; then
  note "PASS: wrong post-install version blocks readiness"
else
  note "FAIL: wrong post-install version was accepted" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  note "FAILED"
  exit 1
fi
note "OK"
