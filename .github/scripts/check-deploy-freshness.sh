#!/usr/bin/env bash
# Determines whether $1 (the commit currently being deployed) is still the
# freshest DEPLOY-RELEVANT commit compared to $2 (cf-sfu's current HEAD).
# Prints exactly "stale=true" or "stale=false" to stdout — nothing else.
#
# "Deploy-relevant" mirrors deploy-web.yml's own `on.push.paths` trigger
# (app/**, docs/**, and this workflow file). That trigger is path-filtered,
# so a commit that only touches non-deploy-relevant files (e.g. the root
# README.md) never starts its own deploy run. Comparing raw SHA equality
# against cf-sfu's current tip is therefore wrong: if such a commit lands
# after the one being built, the build is still the latest
# deploy-relevant state and must NOT be skipped — only a commit that
# itself touches app/, docs/, or this workflow makes an in-flight build
# stale (and that commit is guaranteed to have started its own run to
# cover it).
set -euo pipefail

BUILT_SHA="${1:?usage: check-deploy-freshness.sh <built-sha> <latest-sha>}"
LATEST_SHA="${2:?usage: check-deploy-freshness.sh <built-sha> <latest-sha>}"

# Must match on.push.paths in deploy-web.yml exactly.
DEPLOY_PATHS=("app" "docs" ".github/workflows/deploy-web.yml")

if [ "$BUILT_SHA" = "$LATEST_SHA" ]; then
  echo "stale=false"
  exit 0
fi

# `git diff --quiet` exits 0 (no diff), 1 (diff found), or a higher code
# (e.g. 128 for an unresolvable revision — bad fetch, corrupt shallow
# clone, wrong SHA). Only 0/1 are meaningful results; anything else is a
# tooling failure and must abort loudly, not get silently folded into
# "stale=true" by an `if` that only distinguishes zero from non-zero.
set +e
git diff --quiet "$BUILT_SHA" "$LATEST_SHA" -- "${DEPLOY_PATHS[@]}"
diff_status=$?
set -e

case "$diff_status" in
  0) echo "stale=false" ;;
  1) echo "stale=true" ;;
  *)
    echo "check-deploy-freshness: git diff failed unexpectedly (exit $diff_status) comparing $BUILT_SHA..$LATEST_SHA" >&2
    exit 1
    ;;
esac
