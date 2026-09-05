---
name: free4chat-agent-release
description: Prepare, publish, activate, and dogfood a Free4Chat Go Agent Runtime release. Use for a new free4chat-agent version; not for an ordinary Worker-only deployment.
---

# Free4Chat Agent Runtime release

A Runtime release has three ordered phases, not merely an `agent-v*` tag:

```text
source-version PR → verified native GitHub Release → live bootstrap activation PR
```

`app/public/agent.md` is the repository source for deployed `/agent.md`, but
its version pin is a later activation step. Never make a fresh Invite request a
version whose native Release assets are not already published and verified.

## 1. Prepare the source-version PR

Before choosing a version, inspect the current `doctor.Version`, existing
`agent-v*` tags, GitHub Releases, and version-bearing source:

```bash
rg -n "<old-version>|agent-v<old-version>" . \
  --glob '!app/node_modules/**' --glob '!app/.next/**' --glob '!app/.open-next/**'
```

Choose an unused semantic version. Update `agent/internal/doctor/doctor.go`
and only genuinely version-specific Runtime tests. Do **not** update
`app/public/agent.md` or generated `app/public/llms-full.txt` in this PR:
they remain on the latest published native Release until phase 3.

Read `.github/workflows/agent-release.yml` and `agent/scripts/release.sh`.
The eventual tag must exactly equal `doctor.Version`; the workflow builds four
native targets, verifies their reported version, emits `SHA256SUMS`, and
publishes the GitHub Release.

Before merge, run:

```bash
cd agent
go test ./...
go vet ./...
go build ./cmd/free4chat-agent
bash scripts/test-install-agent.sh
bash scripts/test-bootstrap-contract.sh
```

Also run `git diff --check`, inspect the complete PR diff, and do not push the
release tag before the source-version PR is green and merged.

## 2. Publish and verify the native Release

Fetch `origin/cf-sfu` and verify the exact merged commit still declares the
intended `doctor.Version`. Confirm the `agent-v<version>` tag and its GitHub
Release do not exist; create an annotated tag at that exact commit and push
only that tag.

Wait for the Agent Release workflow to succeed. Require all four native
binaries, `SHA256SUMS`, and the GitHub Release. Verify a current-platform
asset with `doctor --json`: it must report the tagged version. A queued,
running, missing, or failed Release is a hard stop for bootstrap activation.

## 3. Activate live bootstrap in a separate PR

Only after phase 2 is verified, create a focused activation PR. Update both
version occurrences in `app/public/agent.md`:

- the human-readable release tag/version;
- `expected_version` in the installer command.

Run `yarn docs:generate` from `app/`, commit the matching
`app/public/llms-full.txt` update, and verify no unrelated generated output
changed. Then run:

```bash
cd agent && bash scripts/test-bootstrap-contract.sh
cd ../app && yarn docs:check && yarn test && yarn type-check
cd ../app && yarn eslint src --no-fix && yarn prettier --check . && yarn cf-build
```

Merge the activation PR only after its PR CI is green. After merge, wait for
the resulting `cf-sfu` Build & Deploy workflow to complete successfully. Only
then verify deployed `/agent.md` serves the release version, tag, and installer
pin. If that deployment fails, treat activation as incomplete: do not claim the
release is live or proceed with production dogfood. This ensures production
never points fresh Invites to a nonexistent binary.

## Production dogfood

In a fresh disposable Room, verify installer selection, installed binary, and
resident daemon all use the activated version before testing participation.
Record only safe evidence: merged SHA, deployed bootstrap version, release
asset/checksum names, and `doctor --json` version. Ask the user only if a
native keychain/keystore approval actually blocks setup; never request or print
credentials, handles, tokens, audio, or transcript content.

Tags, releases, merges, deployments, and local installation are external
mutations. Obtain or use explicit user authorization for each requested step.
