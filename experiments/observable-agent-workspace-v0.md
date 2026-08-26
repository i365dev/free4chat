# Observable Agent Workspace v0 — acceptance experiment (#111)

Ephemeral snapshot surfaces: one latest, explicitly-published workspace image
per Agent participant. **Observation only** — not live remote desktop, not
remote control, never automatic capture. This document describes the
acceptance flow; no live run has been executed yet, so no success is claimed
here.

## Roles

|         | Machine A (publisher)                                                           | Machine B (observer)                                  |
| ------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Harness | any supported Agent with a local screen/screenshot capability (its own tooling) | Human browser, or a second Agent using `surface read` |

Capability isolation: the observer never receives capture credentials; the
publisher's screenshot tooling stays entirely on Machine A.

## Setup

1. Provision a room via either documented variant (Agent `create` or
   Human-created) from `phase-c-zero-human-runbook.md`.
2. Machine A joins with an honest capability list; optionally include
   `workspace.publish` as descriptive metadata (capability ≠ authorization;
   the participant's own room membership is what authorizes its own surface).

## Flow

1. **Publish.** On Machine A, capture a screenshot with whatever local tool
   the Harness already owns (OS shortcut, editor export, etc.) and publish:

   ```bash
   free4chat-agent surface publish --file ./workspace.png [--instance <id>]
   ```

   Output is metadata only (snapshotId/mimeType/size/updatedAt) — never base64.

2. **Human observes.** In the room UI (any room type, including audio rooms),
   the "Workspace snapshots — not live" strip shows AgentA's current snapshot
   with explicit not-live wording. No click/type/control UI exists.

3. **Replace.** Change something on A's machine, capture again, publish again.
   The old snapshot disappears everywhere immediately (new server-generated
   snapshotId; previous chunks deleted).

4. **Peer-Agent read.** From another resident Agent:

   ```bash
   free4chat-agent surface read --participant <agent-a-participant-id>
   ```

   The command pins the CURRENT snapshotId from roster metadata, fetches those
   exact bytes into the instance workspace (`surfaces/<snapshotId>.<ext>`),
   and prints metadata plus the local temporary path. The file dies with the
   instance workspace.

5. **Clear / lifecycle.** `free4chat-agent surface clear` removes it at once.
   Leaving the room, lease expiry, and room expiry also remove everything,
   including orphan chunks.

6. **Negative checks.**
   - Publishing again within 2 seconds → `surface_rate_limited`.
   - A 4th distinct publisher while 3 hold surfaces → `surface_capacity_exceeded`.
   - Reading with a stale snapshotId → `surface_changed`.
   - Non-image MIME / oversize → rejected before storage.

## Acceptance checklist

- [ ] Publish → Human sees current snapshot with not-live wording.
- [ ] Replace destroys the previous state everywhere (no history).
- [ ] Peer Agent reads exact current bytes on demand into its own workspace.
- [ ] Clear / leave / lease expiry / room expiry remove all traces.
- [ ] Rate limit + capacity behave as specified; failures leave prior snapshot intact.
- [ ] No control UI anywhere; Human screen share unchanged; Agent media still subscribe-only.
