---
name: free4chat-media-experiment
description: Strict provenance-first SOP for real deployed Free4Chat Meeting Notes, Voice Reply, Pion, Cloudflare SFU, and browser-media experiments.
---

# Free4Chat media experiment SOP

> **Historical / reference-only.** This SOP was written for the frozen
> Node-runtime + sidecar-Pion era. The sidecar architecture no longer exists
> on `cf-sfu`: `agent-runtime/`, `FREE4CHAT_PION_BIN`, and
> `scripts/media-e2e-preflight.sh` are gone, and Pion now runs **in-process**
> inside the canonical Go runtime (`agent/`, released as the
> `free4chat-agent` binary). The historical reproduction path is the frozen
> tag `node-agent-runtime-e2e-2026-08-27` / branch `archive/node-agent-runtime`.
> Provenance and safe-evidence discipline below still applies; the concrete
> build/provisioning steps are marked where they are frozen-era only.

Use this skill for real browser/media experiments against a deployed Free4Chat
environment. It is deliberately separate from `free4chat-local-e2e`, which
covers generic local Worker/DO full-stack tests.

## Hard rule

If experiment provenance cannot be proved, abort the experiment and mark its
result **INVALID**. Do not interpret the logs or use them to choose a fix.

Every experiment changes one variable and answers one question. Do not debug
bootstrap, STT, TTS, Pion, Worker behavior, and browser playback in one run.

## Preflight and provenance

1. State one hypothesis, such as “does current Voice Reply publish outbound
   RTP?”
2. Use the canonical repository only. Do not create a worktree. Fetch and
   resolve `origin/cf-sfu`; use branch `cf-sfu` with a clean tree and record
   the exact `HEAD` SHA. Historical bisects are an explicit separate mode.
3. *(Frozen era only.)* `agent-runtime` exists only in the historical tag
   `node-agent-runtime-e2e-2026-08-27`. For the canonical Go runtime, install
   the official release binary and record its version from
   `free4chat-agent doctor --json` (release assets are SHA256SUMS-verified).
4. *(Frozen era only.)* The separately built Pion executable and
   `FREE4CHAT_PION_BIN` no longer exist: Pion is compiled in-process. Record
   the released `free4chat-agent` version and the SHA256SUMS entry instead of
   a sidecar binary path.
5. *(Frozen era only.)* `scripts/media-e2e-preflight.sh` was removed with the
   sidecar architecture. Its read-only gate discipline (branch, clean-tree,
   origin, provenance, process counts — never starting or killing processes)
   still applies manually. It only reports counts; never terminate unrelated
   OpenCode, Codex, Claude, editor, browser, or user processes.

6. Start exactly one fresh Free4Chat daemon and one resident Agent after the
   process count is zero. Record only process counts and safe executable
   identity. Do not record handles, tokens, session IDs, or credentials.

## Fresh disposable room

Use a new room for every media experiment. Never reuse `test`, `test2`, `test3`,
or another long-lived debugging room. Use labels such as
`e2e-mn-YYYYMMDD-HHMMSS` and `e2e-vr-YYYYMMDD-HHMMSS`. A room contains
participants, leases, grants, and media history, so reuse invalidates a clean
experiment.

## Golden control: Meeting Notes

Before diagnosing Voice after any media or transport change, run the control
with Voice Reply **OFF**. The required gates are:

```text
Agent joined
Pion PeerConnection created
server-events DataChannel created
offer generated
remote answer applied
ICE connected
PeerConnection connected
remote Human audio/opus track received
Meeting Notes UI = Listening
RTP/audio frames observed
real speech reaches STT
at least one committed transcript segment
```

If any control gate fails, stop. The Voice experiment is INVALID; do not
inspect or modify TTS/Voice based on it. The known-good control is current
`cf-sfu` `62b0c54ef0f454a7d00ce264d8520d2935d9bfb3` until a newer verified
baseline replaces it.

## Voice treatment

Use the same repository SHA, released `free4chat-agent` binary (record its
`doctor --json` version), deployed
Worker, browser, credentials, and provider configuration as the control, but
use a second fresh room. Keep Meeting Notes OFF and enable Voice Reply for
exactly one Agent. Send one minimal deterministic request.

Walk the existing implementation in order:

1. Grant: `voiceReplyMediaAvailable`, `active`, and `targetsSelf`.
2. Provider: provider resolved and `voice_reply_started`.
3. Turn: `voice_turn_started`, TTS chunks, PCM frames, and finished/failed.
4. Publication: publish arm, local MID present as a boolean/count only,
   `/tracks` 2xx, remote description applied, publication active.
5. Outbound Pion RTP packet/frame count, if observable.
6. Human/browser: announcement, subscription, `ontrack`, audio `srcObject`,
   and audible playback.

Never infer a later-layer cause when an earlier gate has not passed.

## Safe evidence

Allowed: booleans, HTTP status, safe error codes, counts, media kind/codec,
connection/signaling state, versions, repository SHA, binary path/source SHA,
and disposable room labels.

Never put in output, chat, issues, or PRs: participant IDs, handles/tokens,
API keys, session IDs, identity-bearing track names, MID values, full SDP, ICE
contents or credentials, fingerprints, IPs/addresses, Doubao credentials, raw
audio, transcript text, or upstream response bodies.

## Failure report before any code change

If a real experiment fails, do not edit code, create a PR, or delegate a fix.
First report:

```text
hypothesis
exact repo SHA
free4chat-agent version (doctor --json) and release asset SHA256SUMS entry
fresh room confirmed
free4chat-agent process counts
golden-control result
stage reached
first failed gate
safe evidence
what was ruled out
what remains unknown
```

Then request architecture/root-cause review. A failure without proven
provenance is not evidence.

## Turnstile development switch

The development deployment may temporarily set:

```text
frontend: NEXT_PUBLIC_TURNSTILE_DISABLED=1
Worker:   TURNSTILE_DISABLED=true
```

This is a reversible E2E convenience switch only. It does not remove Origin,
rate-limit, Agent authorization, or media authorization checks. To restore
Turnstile, remove both environment settings; do not delete the existing
site-key or secret configuration.
