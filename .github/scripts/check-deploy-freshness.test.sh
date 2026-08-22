#!/usr/bin/env bash
# Deterministic scenario tests for check-deploy-freshness.sh. No network,
# no GitHub Actions — each scenario builds a throwaway local git repo.
#
# Run: .github/scripts/check-deploy-freshness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-deploy-freshness.sh"
FAIL=0

# Emits results as it goes; caller checks $FAIL at the end. Every temp repo
# is removed even if an assertion fails, so a bad run doesn't leave litter.
check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "ok   - $name"
  else
    echo "FAIL - $name (expected '$expected', got '$actual')"
    FAIL=1
  fi
}

new_repo() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  mkdir -p "$dir/app" "$dir/.github/workflows"
  echo "init" > "$dir/README.md"
  echo "init" > "$dir/app/index.js"
  echo "init" > "$dir/.github/workflows/deploy-web.yml"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
  echo "$dir"
}

commit_change() {
  local dir="$1" file="$2" message="$3"
  echo "changed $(date +%s%N)" > "$dir/$file"
  git -C "$dir" add -A
  git -C "$dir" commit -qm "$message"
  git -C "$dir" rev-parse HEAD
}

# --- Scenario 1: A app change; B docs-only after it => A deploys ---
repo="$(new_repo)"
A="$(commit_change "$repo" app/index.js "A: app change")"
B="$(commit_change "$repo" README.md "B: docs-only")"
result="$(cd "$repo" && bash "$SCRIPT" "$A" "$B")"
check "A app-only, B docs-only after => A deploys" "stale=false" "$result"
rm -rf "$repo"

# --- Scenario 2: A app change; B docs-only; C app change => A skips, C deploys ---
repo="$(new_repo)"
A="$(commit_change "$repo" app/index.js "A: app change")"
B="$(commit_change "$repo" README.md "B: docs-only")"
C="$(commit_change "$repo" app/index.js "C: app change")"
result_a="$(cd "$repo" && bash "$SCRIPT" "$A" "$C")"
check "A skips once C (app change) lands" "stale=true" "$result_a"
result_c="$(cd "$repo" && bash "$SCRIPT" "$C" "$C")"
check "C deploys (it IS the latest)" "stale=false" "$result_c"
rm -rf "$repo"

# --- Scenario 3: A app change; B changes deploy-web.yml => A skips, B deploys ---
repo="$(new_repo)"
A="$(commit_change "$repo" app/index.js "A: app change")"
B="$(commit_change "$repo" .github/workflows/deploy-web.yml "B: workflow change")"
result="$(cd "$repo" && bash "$SCRIPT" "$A" "$B")"
check "A skips once B changes deploy-web.yml (B's own run deploys)" "stale=true" "$result"
rm -rf "$repo"

# --- Scenario 4: freshness lookup fails => must fail loudly, not print stale=true and succeed ---
if bash "$SCRIPT" "only-one-arg" 2>/dev/null; then
  echo "FAIL - missing second arg should exit non-zero, not succeed"
  FAIL=1
else
  echo "ok   - missing second arg exits non-zero (set -euo pipefail + \${:?})"
fi
if bash "$SCRIPT" "0000000000000000000000000000000000000000" "1111111111111111111111111111111111111111" 2>/dev/null; then
  echo "FAIL - unresolvable SHAs should exit non-zero, not silently print stale=true"
  FAIL=1
else
  echo "ok   - unresolvable SHAs make git diff fail, propagating as a non-zero exit"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "One or more scenarios FAILED"
  exit 1
fi
echo "All scenarios passed"
