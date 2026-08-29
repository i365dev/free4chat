#!/usr/bin/env bash
# Deterministic contract tests for the fresh Invite Runtime bootstrap.
#
# The host-side bootstrap is documented in app/public/agent.md and copied into
# the Invite prompt. Source Runtime version and live bootstrap expected version
# are intentionally staged independently during a release rollout; this test
# keeps both values valid and checks the activation contract separately.
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
  note "PASS: source version is stable semantic version"
else
  note "FAIL: source version is not a stable semantic version: '$source_version'" >&2
  fail=1
fi
if [[ "$doc_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  note "PASS: live agent.md version is stable semantic version"
else
  note "FAIL: live agent.md version is not a stable semantic version: '$doc_version'" >&2
  fail=1
fi
if [ "$doc_version" != "$source_version" ]; then
  note "PASS: source and live bootstrap versions may be staged independently"
else
  note "INFO: source and live bootstrap versions are currently aligned"
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
expect_text "version query is the local check" '"$runtime_bin" version --json' "$DOC"
expect_text "published old releases have a fallback" 'fall back to' "$DOC"
expect_text "doctor is the compatibility fallback" '"$runtime_bin" doctor --json' "$DOC"
expect_text "both probes must fail before fail-closed install" 'both commands fail' "$DOC"
expect_text "bootstrap preserves resolved executable path" 'runtime_bin="$(command -v free4chat-agent || true)"' "$DOC"
expect_text "join uses resolved executable path" '"$runtime_bin" join' "$DOC"
expect_text "installer destination precedence is documented" 'FREE4CHAT_AGENT_INSTALL_DIR`, then `XDG_BIN_HOME`, then' "$DOC"
expect_text "bootstrap never re-resolves after install" 're-run `command -v` or invoke the bare `free4chat-agent` name after an' "$DOC"
expect_text "installer is pinned to expected version" 'FREE4CHAT_AGENT_VERSION="$expected_version" bash install-agent.sh' "$DOC"
expect_text "join checks resident daemon version" 'bounded local `daemon-info` handshake' "$DOC"
expect_text "stale daemon cannot be reused" 'refuse to join and report that the host-owned daemon must be stopped' "$DOC"
expect_text "daemon version is required to match" 'daemonVersion` as the expected version above' "$DOC"

join_line="$(grep -nF '   "$runtime_bin" join' "$DOC" | tail -1 | cut -d: -f1)"
verify_line="$(grep -n 'equals the expected version above' "$DOC" | tail -1 | cut -d: -f1)"
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

fake_install_current() {
  local install_dir="$1"
  local requested_version="${FREE4CHAT_AGENT_VERSION:-latest}"
  printf '%s\n' "$requested_version" > "$WORK/install-version"
  if [ "$requested_version" != "$doc_version" ]; then
    return 1
  fi
  mkdir -p "$install_dir"
  cp "$WORK/published-v0.5.4" "$install_dir/free4chat-agent"
  chmod 0755 "$install_dir/free4chat-agent"
}

bootstrap_runtime_bin() {
  local expected="$1" runtime_bin installed install_dir
  runtime_bin="$(command -v free4chat-agent 2>/dev/null || true)"
  if [ -n "$runtime_bin" ]; then
    installed="$(probe_runtime_version "$runtime_bin")" || installed=""
    if [ "$installed" = "$expected" ]; then
      printf '%s\n' "$runtime_bin"
      return 0
    fi
  fi

  if [ -n "${FREE4CHAT_AGENT_INSTALL_DIR:-}" ]; then
    install_dir="$FREE4CHAT_AGENT_INSTALL_DIR"
  elif [ -n "${XDG_BIN_HOME:-}" ]; then
    install_dir="$XDG_BIN_HOME"
  elif [ -n "${HOME:-}" ]; then
    install_dir="$HOME/.local/bin"
  else
    return 1
  fi
  export FREE4CHAT_AGENT_VERSION="$expected"
  if ! fake_install_current "$install_dir"; then
    return 1
  fi
  runtime_bin="$install_dir/free4chat-agent"
  installed="$(probe_runtime_version "$runtime_bin")" || installed=""
  if [ "$installed" != "$expected" ]; then
    return 1
  fi
  printf '%s\n' "$runtime_bin"
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

write_fake_agent "$WORK/published-v0.5.4" 'echo unsupported >&2; exit 2' "$doc_version"
write_fake_agent "$WORK/stale-contract" 'echo unsupported >&2; exit 2' "0.5.3"
write_fake_agent "$WORK/newer-contract" 'printf "%s\\n" "{\\"version\\":\\"0.5.5\\"}"' "$source_version"
write_fake_agent "$WORK/malformed-contract" 'echo not-json; exit 0' "not-a-version"
write_fake_agent "$WORK/wrong-after-install" 'echo unsupported >&2; exit 2' "0.5.3"

if [ "$(bootstrap_action "$WORK/published-v0.5.4" "$doc_version")" = reuse ] &&
  [ "$(probe_runtime_version "$WORK/published-v0.5.4")" = "$doc_version" ]; then
  note "PASS: published old-contract binary reuses via doctor fallback"
else
  note "FAIL: published old-contract binary did not reuse via doctor fallback" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/free4chat-agent" "$source_version")" = reuse ]; then
  note "PASS: source binary reports its exact version via fast path"
else
  note "FAIL: source binary did not report its exact version" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/free4chat-agent" "$doc_version")" = install ]; then
  note "PASS: source version can lead live bootstrap activation"
else
  note "FAIL: live bootstrap unexpectedly accepted a not-yet-activated source version" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/stale-contract" "$doc_version")" = install ]; then
  note "PASS: older old-contract binary selects installer"
else
  note "FAIL: older old-contract binary bypassed installer" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/newer-contract" "$doc_version")" = install ]; then
  note "PASS: newer binary selects installer"
else
  note "FAIL: newer binary was silently accepted" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/malformed-contract" "$doc_version")" = install ]; then
  note "PASS: malformed probes fail closed"
else
  note "FAIL: malformed probes were silently accepted" >&2
  fail=1
fi
if [ "$(bootstrap_action "$WORK/missing-agent" "$doc_version")" = install ]; then
  note "PASS: missing binary selects installer"
else
  note "FAIL: missing binary did not select installer" >&2
  fail=1
fi
if [ "$(probe_runtime_version "$WORK/wrong-after-install" 2>/dev/null)" != "$doc_version" ]; then
  note "PASS: wrong post-install version blocks readiness"
else
  note "FAIL: wrong post-install version was accepted" >&2
  fail=1
fi

# Verify that a stale executable earlier on PATH cannot win after installation.
# The fake installer writes to the normal user directory, while command -v
# continues to resolve the stale binary first. The bootstrap must retain and
# use the explicit post-install destination instead.
old_bin_dir="$WORK/fake-old/bin"
default_bin_dir="$WORK/home/.local/bin"
mkdir -p "$old_bin_dir" "$WORK/home"
cp "$WORK/stale-contract" "$old_bin_dir/free4chat-agent"
chmod 0755 "$old_bin_dir/free4chat-agent"
if (
  export HOME="$WORK/home"
  unset FREE4CHAT_AGENT_INSTALL_DIR XDG_BIN_HOME
  export PATH="$old_bin_dir:$PATH"
  resolved_bin="$(bootstrap_runtime_bin "$doc_version")"
  expected_bin="$default_bin_dir/free4chat-agent"
  [ "$resolved_bin" = "$expected_bin" ] &&
    [ "$(command -v free4chat-agent)" = "$old_bin_dir/free4chat-agent" ] &&
    [ "$(probe_runtime_version "$resolved_bin")" = "$doc_version" ] &&
    [ "$(cat "$WORK/install-version")" = "$doc_version" ]
); then
  note "PASS: stale earlier PATH entry cannot override post-install runtime"
else
  note "FAIL: stale earlier PATH entry still controls post-install runtime" >&2
  fail=1
fi

# The explicit installer override must also become the exact executable used
# for verification and the eventual join.
custom_bin_dir="$WORK/custom/bin"
if (
  export HOME="$WORK/home"
  export FREE4CHAT_AGENT_INSTALL_DIR="$custom_bin_dir"
  unset XDG_BIN_HOME
  export PATH="$old_bin_dir:$PATH"
  resolved_bin="$(bootstrap_runtime_bin "$doc_version")"
  expected_bin="$custom_bin_dir/free4chat-agent"
  [ "$resolved_bin" = "$expected_bin" ] &&
    [ "$(probe_runtime_version "$resolved_bin")" = "$doc_version" ]
); then
  note "PASS: custom install directory remains the selected runtime path"
else
  note "FAIL: custom install directory was not selected for runtime path" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  note "FAILED"
  exit 1
fi
note "OK"
