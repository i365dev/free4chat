---
name: free4chat-agent-release
description: Prepare, publish, activate, and dogfood a Free4Chat Go Agent Runtime release. Use for a new free4chat-agent version; not for an ordinary Worker-only deployment.
---

# Free4Chat Agent Runtime release

A release is three deliberate phases, not merely an `agent-v*` tag:

```text
source-version PR → matching GitHub Release → live bootstrap activation PR
```

The source and the public bootstrap may intentionally be staged separately.
Never make a fresh Invite request a version whose Release assets are not yet
published.

## 1. Prepare the source-version PR

1. Inspect the current `agent/internal/doctor/doctor.go` version, existing
   `agent-v*` tags, and GitHub Releases. Choose a new semantic version that
   does not reuse a tag.
2. Update `doctor.Version`. Search for version-bearing references with `rg`;
   update source-level release or installer tests only when their expectations
   are actually version-specific. Do not mechanically rewrite historical docs.
3. Read `.github/workflows/agent-release.yml` and `agent/scripts/release.sh`.
   The pushed tag must exactly equal `doctor.Version`; CI builds four native
   targets, verifies their reported version, and publishes SHA256SUMS.
4. Before requesting/performing merge, run from `agent/`:

   ```bash
   go test ./...
   go vet ./...
   go build ./cmd/free4chat-agent
   bash scripts/test-install-agent.sh
   bash scripts/test-bootstrap-contract.sh
   ```

   Also run `git diff --check` and inspect the full PR diff. Keep this PR
   focused on release preparation; do not push the release tag before merge.

## 2. Publish the matching native release

After the source-version PR is green and merged, fetch `origin/cf-sfu` and
verify the merged commit still declares the intended `doctor.Version`. Confirm
both the Git tag and GitHub Release do not already exist, then create an
annotated `agent-v<doctor.Version>` tag at that exact merged commit and push
only that tag.

Monitor the Agent Release workflow to completion. Require all four named
native binaries, `SHA256SUMS`, and the GitHub Release. Verify a current-platform
release binary reports the tagged version through `doctor --json` before
activating public bootstrap documentation.

Tags, releases, merges, and deployments are external mutations: obtain or use
explicit user authorization for each requested step.

## 3. Activate live bootstrap documentation

Only after the matching GitHub Release is available, make a focused activation
PR that updates both expected-version occurrences in `app/public/agent.md`:

- the human-readable version/tag line;
- `expected_version` in the installer command.

Run `yarn docs:generate` in `app/`; commit the resulting
`app/public/llms-full.txt` update, and verify no unrelated generated output
changed. Then run:

```bash
cd agent && bash scripts/test-bootstrap-contract.sh
cd app && yarn docs:check && yarn test && yarn type-check
cd app && yarn eslint src --no-fix && yarn prettier --check . && yarn cf-build
```

Merge the activation PR only with the normal `cf-sfu` deployment green. This
ensures a fresh Invite sees a published installer version, not just source
code that happens to name a future release.

## Production dogfood

Record only safe evidence: merged SHA, deployed bootstrap version, release
asset/checksum name, and `doctor --json` version. In a fresh disposable Room,
verify that installer selection, installed binary, and resident daemon all use
the exact activated version before testing resident participation. Ask the user
only if a native keychain/keystore approval actually blocks installation; never
request or print credentials, handles, tokens, audio, or transcript content.
