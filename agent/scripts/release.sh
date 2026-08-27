#!/usr/bin/env bash
# Native distribution build for the Go Agent Runtime.
#
# Builds the self-contained free4chat-agent binary for every supported
# platform (darwin/linux x arm64/amd64, CGO disabled) and writes a
# SHA256SUMS manifest over exactly those four binaries. Usage:
#
#   agent/scripts/release.sh [version]
#
# The version defaults to the canonical runtime version in
# agent/internal/doctor/doctor.go; release CI passes the agent-v<version>
# tag-derived version explicitly and cross-checks it. The version is
# injected into the binary via -ldflags so that `doctor --json` and
# `readiness --json` report the exact release version.
#
# CI matrix runners build one target at a time with:
#   RELEASE_ONLY=darwin/arm64 RELEASE_OUT=<dir> agent/scripts/release.sh <version>
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-$(sed -n 's/^var Version = "\([^"]*\)"$/\1/p' internal/doctor/doctor.go)}"
if [ -z "$VERSION" ]; then
  echo "unable to resolve runtime version" >&2
  exit 1
fi

OUT="${RELEASE_OUT:-dist}"
LDFLAGS="-s -w -X github.com/i365dev/free4chat/agent/internal/doctor.Version=${VERSION}"

build_one() {
  local goos="$1" goarch="$2"
  local binary="$OUT/free4chat-agent-$goos-$goarch"
  echo "building $binary (version $VERSION)"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -ldflags "$LDFLAGS" \
    -o "$binary" \
    ./cmd/free4chat-agent
}

write_checksums() {
  (
    cd "$OUT"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum free4chat-agent-darwin-arm64 free4chat-agent-darwin-amd64 \
        free4chat-agent-linux-arm64 free4chat-agent-linux-amd64 > SHA256SUMS
      sha256sum -c SHA256SUMS
    else
      shasum -a 256 free4chat-agent-darwin-arm64 free4chat-agent-darwin-amd64 \
        free4chat-agent-linux-arm64 free4chat-agent-linux-amd64 > SHA256SUMS
      shasum -a 256 -c SHA256SUMS
    fi
  )
}

case "${RELEASE_ONLY:-}" in
  darwin/arm64) build_one darwin arm64 ;;
  darwin/amd64) build_one darwin amd64 ;;
  linux/arm64) build_one linux arm64 ;;
  linux/amd64) build_one linux amd64 ;;
  "")
    rm -rf "$OUT"
    mkdir -p "$OUT"
    build_one darwin arm64
    build_one darwin amd64
    build_one linux arm64
    build_one linux amd64
    write_checksums
    echo "release artifacts:"
    ls -la "$OUT"
    ;;
  *)
    echo "unsupported RELEASE_ONLY=${RELEASE_ONLY}" >&2
    exit 1
    ;;
esac
