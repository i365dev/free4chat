#!/usr/bin/env bash
# Deterministic offline tests for app/public/install-agent.sh.
#
# The installer's ONLY binary source is the official GitHub Release. There is
# deliberately no production download-source override, so these tests replace
# `curl` itself with a mock that (a) requires the installer to request the
# official release URL over HTTPS (`--proto '=https'`), (b) records the URLs
# the installer asked for, and (c) serves local fake assets. The shipped
# installer is never patched or pointed anywhere else.
#
# Run from the repository root:
#   bash agent/scripts/test-install-agent.sh
set -u

cd "$(dirname "$0")/../.."
INSTALLER="$(pwd)/app/public/install-agent.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-agent-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

note_ok() { echo "PASS: $1"; pass=$((pass + 1)); }
note_bad() { echo "FAIL: $1"; fail=$((fail + 1)); }

# --- regression: the shipped installer has no download-source override -----
if grep -q "FREE4CHAT_AGENT_DOWNLOAD_BASE" "$INSTALLER"; then
  note_bad "installer contains a download-source override"
else
  note_ok "installer has no download-source override"
fi
if grep -q -- "--proto '=https'" "$INSTALLER"; then
  note_ok "installer enforces HTTPS download"
else
  note_bad "installer does not enforce HTTPS download"
fi

# --- host platform (so the installed binary can actually run) --------------
host_os="$(uname -s)"
host_arch="$(uname -m)"
case "$host_os" in
  Darwin) goos="darwin" ;;
  Linux) goos="linux" ;;
  *) echo "unsupported test host: $host_os" >&2; exit 1 ;;
esac
case "$host_arch" in
  arm64 | aarch64) goarch="arm64" ;;
  x86_64 | amd64) goarch="amd64" ;;
  *) echo "unsupported test host arch: $host_arch" >&2; exit 1 ;;
esac
asset_name="free4chat-agent-$goos-$goarch"
canonical_version="$(sed -n 's/^var Version = "\([^"]*\)"$/\1/p' agent/internal/doctor/doctor.go)"
[ -n "$canonical_version" ] || { echo "canonical runtime version missing" >&2; exit 1; }

# --- fake release assets: a real host binary + SHA256SUMS ------------------
mkdir -p "$WORK/assets"
(
  cd agent
  # The fake asset only needs to run on this test host. Keep native cgo on
  # macOS so the optional Keychain package remains available; release builds
  # still use the CGO-disabled matrix in agent/scripts/release.sh.
  GOCACHE="$WORK/go-cache" CGO_ENABLED=1 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -o "$WORK/assets/$asset_name" ./cmd/free4chat-agent
)
asset_hash="$(shasum -a 256 "$WORK/assets/$asset_name" 2>/dev/null | awk '{print $1}')"
if [ -z "$asset_hash" ]; then
  asset_hash="$(sha256sum "$WORK/assets/$asset_name" | awk '{print $1}')"
fi
printf '%s  %s\n' "$asset_hash" "$asset_name" > "$WORK/assets/SHA256SUMS"

# --- fake PATH tooling ------------------------------------------------------
# mkfakebin <dir> <with-curl> <with-hash-tools> [fake-os] [fake-arch]
mkfakebin() {
  local d="$1"
  local os_override="${4:-$host_os}"
  local arch_override="${5:-$host_arch}"
  mkdir -p "$d"
  cat > "$d/uname" <<EOF
#!/bin/bash
if [ "\$1" = "-s" ]; then echo "$os_override"; else echo "$arch_override"; fi
EOF
  chmod +x "$d/uname"
  ln -s /bin/bash "$d/bash" 2>/dev/null || true
  for tool in awk mktemp rm mkdir cp chmod mv basename; do
    path="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$path" ] && ln -sf "$path" "$d/$tool"
  done
  if [ "$2" = 1 ]; then
    cat > "$d/curl" <<'FAKECURL'
#!/bin/bash
out=""; url=""; saw_proto=0; prev=""
for arg in "$@"; do
  if [ "$prev" = o ]; then out="$arg"; prev=""; continue; fi
  case "$arg" in
    -o) prev=o ;;
    --proto) saw_proto=1 ;;
    -* | =*) ;;
    *) url="$arg" ;;
  esac
done
[ -n "$out" ] || exit 1
[ "$saw_proto" = 1 ] || { echo "fake curl: --proto '=https' not requested" >&2; exit 1; }
case "$url" in
  "https://github.com/i365dev/free4chat/releases/"*) ;;
  *) echo "fake curl: non-official URL rejected: $url" >&2; exit 1 ;;
esac
if [ -n "${FAKE_CURL_LOG:-}" ]; then echo "$url" >> "$FAKE_CURL_LOG"; fi
if [ "${FAKE_CURL_FAIL:-0}" = 1 ]; then exit 22; fi
src="$FAKE_ASSETS/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"
FAKECURL
    chmod +x "$d/curl"
  fi
  if [ "$3" = 1 ]; then
    for tool in sha256sum shasum; do
      path="$(command -v "$tool" 2>/dev/null || true)"
      [ -n "$path" ] && ln -sf "$path" "$d/$tool"
    done
  fi
}

run_case() { # $1 = name, $2 = expect(ok|fail), rest = command
  local name="$1" expect="$2"
  shift 2
  local out code
  out="$("$@" 2>&1)"
  code=$?
  if { [ "$expect" = ok ] && [ "$code" -eq 0 ]; } ||
    { [ "$expect" = fail ] && [ "$code" -ne 0 ]; }; then
    note_ok "$name (exit $code)"
  else
    note_bad "$name (exit $code, expected $expect)"
    echo "$out" | head -3
  fi
}

FAKEBIN="$WORK/f1"; mkfakebin "$FAKEBIN" 1 1 SunOS x86_64
run_case "unsupported OS" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"

FAKEBIN="$WORK/f2"; mkfakebin "$FAKEBIN" 1 1 Linux s390x
run_case "unsupported arch" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"

FAKEBIN="$WORK/f3"; mkfakebin "$FAKEBIN" 0 0
run_case "missing curl" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"

FAKEBIN="$WORK/f4"; mkfakebin "$FAKEBIN" 1 0
run_case "missing checksum tools" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"

FAKEBIN="$WORK/f5"; mkfakebin "$FAKEBIN" 1 1
run_case "failed release download" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" FAKE_CURL_FAIL=1 bash "$INSTALLER"

FAKEBIN="$WORK/f6"; mkfakebin "$FAKEBIN" 1 1
mv "$WORK/assets/SHA256SUMS" "$WORK/assets/SHA256SUMS.good"
printf '%s  free4chat-agent-linux-amd64\n' "$(printf '0%.0s' {1..64})" > "$WORK/assets/SHA256SUMS"
run_case "missing checksum entry" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"

FAKEBIN="$WORK/f7"; mkfakebin "$FAKEBIN" 1 1
printf '%s  %s\n' "$(printf 'f%.0s' {1..64})" "$asset_name" > "$WORK/assets/SHA256SUMS"
run_case "checksum mismatch" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"

mv "$WORK/assets/SHA256SUMS.good" "$WORK/assets/SHA256SUMS"
FAKEBIN="$WORK/f8"; mkfakebin "$FAKEBIN" 1 1
run_case "unwritable destination" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" FREE4CHAT_AGENT_INSTALL_DIR="/etc/free4chat-agent-test" bash "$INSTALLER"

FAKEBIN="$WORK/f9"; mkfakebin "$FAKEBIN" 1 1
run_case "invalid pinned version" fail /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" FREE4CHAT_AGENT_VERSION="0.5.0; rm -rf" bash "$INSTALLER"

# Happy path: latest release, install, execute, verify runtime.
FAKEBIN="$WORK/f10"; mkfakebin "$FAKEBIN" 1 1
LOG="$WORK/urls-latest.log"
run_case "happy path (latest)" ok /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" FAKE_CURL_LOG="$LOG" bash "$INSTALLER"
if [ -x "$WORK/home/.local/bin/free4chat-agent" ] &&
  "$WORK/home/.local/bin/free4chat-agent" doctor --json 2>/dev/null |
  grep -q '"runtime": "go"'; then
  note_ok "installed binary is executable and runs (runtime=go)"
else
  note_bad "installed binary does not run"
fi
if [ -x "$WORK/home/.local/bin/free4chat-agent" ] &&
  "$WORK/home/.local/bin/free4chat-agent" version --json 2>/dev/null |
  grep -q "\"version\": \"$canonical_version\""; then
  note_ok "installed binary reports the canonical runtime version"
else
  note_bad "installed binary does not report the canonical runtime version"
fi
if grep -q "releases/latest/download/$asset_name" "$LOG" 2>/dev/null; then
  note_ok "latest mode used the official latest-download URL"
else
  note_bad "latest mode did not use the official latest-download URL"
fi

# Existing binaries are replaced only after the new download has passed the
# same checksum gate; the fresh install must not silently keep stale bytes.
EXISTING_HOME="$WORK/home-existing"
mkdir -p "$EXISTING_HOME/.local/bin"
printf '%s\n' stale-binary > "$EXISTING_HOME/.local/bin/free4chat-agent"
FAKEBIN="$WORK/f12"; mkfakebin "$FAKEBIN" 1 1
run_case "existing binary replacement" ok /usr/bin/env -i HOME="$EXISTING_HOME" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" bash "$INSTALLER"
if cmp "$WORK/assets/$asset_name" "$EXISTING_HOME/.local/bin/free4chat-agent" >/dev/null 2>&1; then
  note_ok "existing binary was replaced by the verified release asset"
else
  note_bad "existing binary was not replaced"
fi

# Happy path with a pinned version: the URL must be the official tag URL.
FAKEBIN="$WORK/f11"; mkfakebin "$FAKEBIN" 1 1
LOG="$WORK/urls-pinned.log"
run_case "happy path (pinned version)" ok /usr/bin/env -i HOME="$WORK/home" PATH="$FAKEBIN" \
  FAKE_ASSETS="$WORK/assets" FAKE_CURL_LOG="$LOG" FREE4CHAT_AGENT_VERSION="0.5.0" bash "$INSTALLER"
if grep -q "releases/download/agent-v0.5.0/$asset_name" "$LOG" 2>/dev/null; then
  note_ok "pinned mode used the official tag-download URL"
else
  note_bad "pinned mode did not use the official tag-download URL"
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
