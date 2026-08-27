#!/usr/bin/env bash
set -euo pipefail

# Read-only provenance gate for real deployed-media experiments. It never
# starts or stops anything; an experiment runner must handle lifecycle after
# this command succeeds.

usage() {
  echo "usage: $0 --pion-bin /absolute/path/to/pion" >&2
  exit 2
}

PION_BIN="${FREE4CHAT_PION_BIN:-}"
while (($# > 0)); do
  case "$1" in
    --pion-bin)
      (($# >= 2)) || usage
      PION_BIN="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

failures=0
fail() {
  echo "preflight_error=$1" >&2
  failures=$((failures + 1))
}

branch="$(git branch --show-current)"
echo "repo_branch=$branch"
[[ "$branch" == "cf-sfu" ]] || fail "branch_must_be_cf-sfu"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "git_status_clean=false"
  fail "working_tree_not_clean"
else
  echo "git_status_clean=true"
fi

head_sha="$(git rev-parse HEAD)"
echo "repo_sha=$head_sha"
if origin_sha="$(git rev-parse --verify refs/remotes/origin/cf-sfu 2>/dev/null)"; then
  echo "origin_cf_sfu_sha=$origin_sha"
  [[ "$head_sha" == "$origin_sha" ]] || fail "head_differs_from_origin-cf-sfu"
else
  echo "origin_cf_sfu_resolvable=false"
  fail "origin-cf-sfu_not_fetched"
fi

runtime_version="$(node -p "require('./agent-runtime/package.json').version")"
echo "runtime_version=$runtime_version"
if [[ -f agent-runtime/dist/cli.js ]]; then
  echo "runtime_build=present"
else
  echo "runtime_build=required"
  fail "runtime_build_missing"
fi

if [[ -z "$PION_BIN" ]]; then
  fail "pion_binary_not_supplied"
else
  echo "pion_binary=$PION_BIN"
  [[ "$PION_BIN" == /* ]] || fail "pion_binary_path_must_be_absolute"
  [[ -f "$PION_BIN" ]] || fail "pion_binary_missing"
  [[ -x "$PION_BIN" ]] || fail "pion_binary_not_executable"
fi
echo "pion_source_identity=unverified"

if ! process_snapshot="$(ps -axo pid=,command= 2>/dev/null)"; then
  fail "cannot_inspect_processes"
  process_snapshot=""
fi
runtime_count="$(printf '%s\n' "$process_snapshot" | awk '$0 ~ /free4chat-agent|agent-runtime\/dist\/cli\.js/ {count++} END {print count+0}')"
pion_count="$(printf '%s\n' "$process_snapshot" | awk '$0 ~ /pion-cloudflare|experiments\/pion-cloudflare/ {count++} END {print count+0}')"
echo "free4chat_runtime_processes=$runtime_count"
echo "free4chat_pion_processes=$pion_count"
((runtime_count == 0)) || fail "free4chat_runtime_processes_running"
((pion_count == 0)) || fail "free4chat_pion_processes_running"

if ((failures > 0)); then
  echo "preflight=FAIL"
  exit 1
fi
echo "preflight=PASS"
