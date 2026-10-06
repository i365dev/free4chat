---
name: free4chat-lifecycle-diagnostics
description: Diagnose one Free4Chat Room App or Generated Task App lifecycle failure across Browser, Room projection, and Runtime using bounded existing diagnostics. Requires valid Runtime provenance before comparing evidence; stops before speculative implementation.
---

# Free4Chat lifecycle diagnostics

Use this skill when a concrete Room App or Generated Task App lifecycle symptom
crosses Browser, Room/projection, and Runtime boundaries, for example a
Generated App capability returning `unavailable`. This is a diagnostic
workflow, not a tracing system or a recovery implementation.

Follow this order:

```text
provenance
→ concrete symptom
→ preserve known-healthy boundaries
→ Browser diagnostics
→ Runtime diagnostics
→ chronological correlation
→ first divergent transition
→ recovery owner
→ one-variable reproduction
→ deterministic failing test only after real divergence
→ stop before implementation unless explicitly asked
```

## 0. Runtime provenance is a mandatory first gate

Before comparing direct Runtime evidence with Room, Browser, App, capability,
or participant-transport evidence:

1. Resolve the exact `free4chat-agent` executable used by the experiment (for
   example, inspect `command -v free4chat-agent`) and the intended
   `FREE4CHAT_AGENT_DIR`. Keep their private local paths out of shared notes.
2. From that same shell, with the intended `FREE4CHAT_AGENT_DIR` set, run the
   provenance command through the resolved executable:

   ```bash
   : "${FREE4CHAT_AGENT_DIR:?select the intended Runtime root first}"
   agent_bin="$(command -v free4chat-agent)"
   "$agent_bin" provenance --room <room-id>
   # Or select the exact Runtime instance:
   "$agent_bin" provenance --instance <instance-id>
   ```

3. Continue only when `decision=valid`.
4. Require CLI and daemon build identities to match, and require the CLI and
   daemon Runtime-root identities to match.
5. Require the selector to match exactly one resident, and verify that its
   `runtimeHostId` is the expected Runtime host for this experiment.

Treat `mismatch` or `ambiguous`, a missing identity, or a non-unique resident
selection as **non-comparable evidence**. Correct executable/root/daemon
selection and rerun provenance before diagnosing a transport failure. Keep
the same executable and `FREE4CHAT_AGENT_DIR` for the observations being
compared.

Multiple isolated daemons are supported. The invariant is exact build, root,
daemon, resident, and originating-Agent attribution; there is no one-daemon-
per-machine requirement.

In particular:

```text
direct Runtime invoke works
+ Generated App fails
```

does **not** establish a transport regression until both observations are
proven to use the same Runtime root, daemon, and originating Agent lifecycle.
The same rule applies to any direct Runtime versus Room/Browser comparison.

## Diagnose one lifecycle

1. **Name one concrete symptom.** Record the visible result and the action that
   preceded it, such as “this capability click returned `unavailable`.” Avoid
   starting from a theory like “the DataChannel regressed.”
2. **Preserve known-healthy boundaries.** Note the last verified event at each
   adjacent layer (for example, direct capability invocation succeeds and the
   App surfaces a bounded error). Keep the provenance gate attached to any
   cross-layer comparison.
3. **Collect Browser evidence** from the parent Room page's DevTools console,
   not the App iframe. Use the existing bounded, local opt-in surface:

   ```js
   window.__free4chatRoomAppTransportDiagnostics.enable()
   window.__free4chatRoomAppTransportDiagnostics.current()
   window.__free4chatRoomAppTransportDiagnostics.read()
   window.__free4chatRoomAppTransportDiagnostics.disable()
   ```

   Capture `current()` and `read()` on each relevant Human Room page around
   the event. Find the **first failed lifecycle transition**, not just the
   final public `unavailable`. Follow the local subscriber, publisher,
   PeerConnection, and Room-socket epochs/generations and bounded reason
   classes. The trace is off by default, page-local, bounded, and observational;
   it does not alter retry or recovery behavior. Call `disable()` after capture.
   Remove participant IDs before sharing evidence.
4. **Collect Runtime evidence** from the existing Runtime participant-transport
   diagnostics. Correlate the projection generation with the ordered lifecycle:

   ```text
   projection generation
   → Start / Update
   → success / bounded failure class
   → retry
   → retry exhaustion or started/updated
   → recovery owner
   ```

   Relevant events include `projection_generation_changed`, `start_succeeded`,
   `update_started`, `update_succeeded`, `start_failed`, `update_failed`, and
   `start_retry_exhausted` / `update_retry_exhausted`. Use only bounded failure
   classes (such as `allocation_failed`, `channel_ready_timeout`,
   `context_cancelled`, or `other`). Treat `start_succeeded` and
   `update_succeeded` (`transport_started=true`) as Runtime-side ready evidence.
   Never copy raw provider/SFU errors or identifiers into diagnostic notes.
5. **Correlate chronologically** in one sanitized table. Use local aliases and
   monotonic epochs/generations; align Room projection events with Browser and
   Runtime events by order and lifecycle generation, not private identifiers.

   | Step | Browser subscriber | Room/projection | Runtime publisher | Result |
   | --- | --- | --- | --- | --- |
   | 1 | epoch / lane transition | bounded projection fact | generation / Start or Update | expected / observed |

   Ask: **What is the first transition where expected behavior diverged from
   observed behavior?** Record which component owned recovery, whether the next
   transition/event was guaranteed, and whether the system converged.
6. **Reproduce with one variable changed.** Keep a sanitized Golden PASS trace
   where available; change only one environment or state axis per run. Choose
   validation by the behavior under test:

   - Use [`free4chat-local-e2e`](../free4chat-local-e2e/SKILL.md) for local
     Worker/DO/control-plane validation. Its fake Realtime/peer layers do not
     prove real SFU lifecycle behavior.
   - When real deployed Worker/SFU behavior is necessary, follow
     [`free4chat-deployed-worker-dogfood`](../free4chat-deployed-worker-dogfood/SKILL.md)
     for temporary deployment, safety, and cleanup. Do not duplicate that
     procedure here.
7. Add a deterministic failing test only after the first real divergence is
   established and the test can reproduce it. Until then, preserve the evidence
   and stop before implementation unless the task explicitly asks for a fix.

## Privacy boundary

Never retain or publish Room IDs/names, participant handles or tokens, SFU
session IDs, DataChannel IDs, raw SDP, private Task text, prompts/messages,
capability arguments/results, credentials, private local filesystem paths, or
Runtime host seed material. Use local aliases and monotonic epochs/generations.
Do not paste full browser console output, raw network captures, or unredacted
Runtime logs into an issue.
