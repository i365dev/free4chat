#!/usr/bin/env bash
# Official Free4Chat Agent installer (macOS + Linux).
# Served at: https://www.free4.chat/install-agent.sh
#
# Downloads the self-contained free4chat-agent binary from the official
# GitHub Releases, verifies it against the published SHA256SUMS, and
# installs it into a user-writable directory.
#
# - No sudo, no shell-profile changes, no Node/npm/pnpm/Go required.
# - The official GitHub Release (i365dev/free4chat, agent-v* tags) is the
#   only binary source. No other URL or package name is ever used.
#
# Environment options (all optional):
#   FREE4CHAT_AGENT_VERSION    pin a release, e.g. 0.5.0 (default: latest)
#   FREE4CHAT_AGENT_INSTALL_DIR install directory (default: ~/.local/bin)
set -euo pipefail

readonly BINARY_NAME="free4chat-agent"
readonly RELEASES_BASE="https://github.com/i365dev/free4chat/releases"

die() { printf 'install-agent: error: %s\n' "$*" >&2; exit 1; }
info() { printf 'install-agent: %s\n' "$*"; }

# --- platform detection ---------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) goos="darwin" ;;
  Linux) goos="linux" ;;
  *)
    die "unsupported OS '$os'. free4chat-agent supports macOS (arm64/x86_64) and Linux (arm64/x86_64) only."
    ;;
esac
case "$arch" in
  arm64 | aarch64) goarch="arm64" ;;
  x86_64 | amd64) goarch="amd64" ;;
  *)
    die "unsupported architecture '$arch'. free4chat-agent supports arm64 and x86_64 only."
    ;;
esac

asset_name="$BINARY_NAME-$goos-$goarch"

# --- required tools -------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  die "curl is required to download the official release."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256_tool="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha256_tool="shasum"
else
  die "sha256sum (or shasum -a 256) is required to verify the download."
fi

sha256_of() { # $1 = file
  if [ "$sha256_tool" = "sha256sum" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# --- official release URLs ------------------------------------------------
# The official GitHub Release is the ONLY binary source. Both the binary and
# SHA256SUMS come from the same fixed HTTPS location; there is deliberately
# no environment override for the download base.
if [ -n "${FREE4CHAT_AGENT_VERSION:-}" ]; then
  version="${FREE4CHAT_AGENT_VERSION}"
  case "$version" in
    agent-v*) tag="$version" ;;
    *) tag="agent-v$version" ;;
  esac
  case "$tag" in
    *[!A-Za-z0-9._-]*) die "invalid FREE4CHAT_AGENT_VERSION '$version'." ;;
  esac
  asset_url="$RELEASES_BASE/download/$tag/$asset_name"
  sums_url="$RELEASES_BASE/download/$tag/SHA256SUMS"
else
  asset_url="$RELEASES_BASE/latest/download/$asset_name"
  sums_url="$RELEASES_BASE/latest/download/SHA256SUMS"
fi

# --- download (HTTPS only) ------------------------------------------------
download() { # $1 = url, $2 = destination
  curl -fsSL --proto '=https' -o "$2" "$1"
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/free4chat-agent-install.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

info "platform: $goos/$goarch"
info "downloading $asset_name"
download "$asset_url" "$tmp_dir/$BINARY_NAME" ||
  die "failed to download $asset_url (is the release published?)"
download "$sums_url" "$tmp_dir/SHA256SUMS" ||
  die "failed to download SHA256SUMS from $sums_url"

# --- verify BEFORE installing ---------------------------------------------
expected="$(awk -v asset="$asset_name" '$2 == asset { print $1 }' "$tmp_dir/SHA256SUMS")"
if [ -z "$expected" ]; then
  die "SHA256SUMS has no entry for $asset_name. Aborting."
fi
case "$expected" in
  *[!0-9a-fA-F]*) die "SHA256SUMS entry for $asset_name is malformed. Aborting." ;;
esac
if [ "${#expected}" -ne 64 ]; then
  die "SHA256SUMS entry for $asset_name is malformed. Aborting."
fi
actual="$(sha256_of "$tmp_dir/$BINARY_NAME")"
if [ "$actual" != "$expected" ]; then
  die "checksum mismatch for $asset_name. Aborting; nothing was installed."
fi
info "checksum verified"

# --- install --------------------------------------------------------------
if [ -n "${FREE4CHAT_AGENT_INSTALL_DIR:-}" ]; then
  install_dir="$FREE4CHAT_AGENT_INSTALL_DIR"
else
  if [ -z "${HOME:-}" ]; then
    die "HOME is not set. Set FREE4CHAT_AGENT_INSTALL_DIR to an install directory."
  fi
  install_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
fi
if ! mkdir -p "$install_dir" 2>/dev/null; then
  die "cannot create install directory '$install_dir'."
fi
if [ ! -w "$install_dir" ]; then
  die "install directory '$install_dir' is not writable. Choose a different FREE4CHAT_AGENT_INSTALL_DIR."
fi
tmp_binary="$install_dir/.$BINARY_NAME.tmp.$$"
cp "$tmp_dir/$BINARY_NAME" "$tmp_binary" ||
  die "cannot write to '$install_dir'."
chmod 0755 "$tmp_binary"
mv "$tmp_binary" "$install_dir/$BINARY_NAME" ||
  die "cannot install '$install_dir/$BINARY_NAME'."
info "installed $install_dir/$BINARY_NAME"

# --- next steps -----------------------------------------------------------
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    info "note: '$install_dir' is not on your PATH (this installer never edits shell profiles)."
    info "run it with the full path: '$install_dir/$BINARY_NAME join ...'"
    ;;
esac
info "verify the install: '$install_dir/$BINARY_NAME' doctor"
info "join a room: '$install_dir/$BINARY_NAME' join --room <room-id> --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name>"
