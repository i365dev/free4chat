# Shared context and artifacts

Information in a Free4Chat Room falls into three classes. Keeping them apart
explains most of the product's privacy, lifecycle, and activation behavior.

## Private participant context

Everything a participant has not deliberately shared stays private:

- Harness reasoning/conversation history;
- local files and tool state;
- credentials/cookies;
- private memory;
- private participant handles/tokens.

The Room never needs this state merely because the participant joined.

## Room-shared ephemeral context

What participants intentionally exchange becomes bounded shared context:

- **Room messages and events** - text and structured addressing metadata;
- **structured requests/results** - accepted/declined and completed/failed
  collaboration lifecycle;
- **presence/capability metadata** - compact current participant projection;
- **committed Live Transcript** - when a Human has authorized a transcript
  host;
- **Task-correlated interaction** - the bounded conversation/activity/artifact
  context associated with one focused Agent Task;
- **artifact/surface references** - ids that let authorized participants read
  explicit payloads on demand;
- **current Task Live View** - one bounded canonical declarative snapshot when
  an Agent publishes one for a Task.

This context lives with the Room and disappears when the Room expires. A Task
does not create permanent history or a durable workspace.

## Room conversation vs Task context

Ordinary Room interaction and focused Tasks are separate presentation and
cognition scopes, and they stay separate even when the same Agent takes part in
both. Task-scoped text and artifacts are not re-presented as unrelated
Room-level output.

[Tasks and Live Views](../guides/tasks-and-live-views) covers what a Task is
and how a Human works with one.

## Explicit artifacts

Larger/structured payloads move as explicit bounded artifacts.

### Attachments

Room-level attachments appear in ordinary Room context. Task-scoped Agent
attachments belong to the Task that produced them and are not silently exposed
to unrelated Agent Tasks.

Supported Agent-readable attachments are bounded images and text-like files,
at most 768 KB each. They have no public permanent URL and expire with the
Room. This is a smaller, separate path from browser-to-browser ephemeral file
transfer, which allows up to 20 MB.

### Workspace surface

A participant may publish one current workspace snapshot image. This is
explicit observation, not automatic capture, remote desktop, or remote
control. Replacing/clearing the snapshot does not create permanent surface
history.

### Task Live View

A Task may have one current bounded declarative Live View published by its
canonical Agent.

```text
Agent publishes canonical snapshot
→ Free4Chat validates/renders it
→ Human may interact locally
```

Current Live View components are intentionally small (Text, Value, Button,
Input, Row, Column, Card). The important state split is:

```text
canonical Live View snapshot
= Room-shared Task state

Human button/input values after local interaction
= browser-local state
```

For example, one Human may click a counter from `0` to `2`; a Human who joins
later receives the canonical snapshot (for example `0`), not the first
browser's private local `2`.

When the Agent publishes a higher revision for the same surface, that becomes
the new canonical snapshot. Free4Chat does not keep a Live View revision
history.

## Visibility is not activation

One of the core invariants:

```text
visibility != activation
```

A participant may observe shared context without being asked to act on it.
Visible `@Name` text is prose; structured addressing/Task routing decides
attention.

The same rule applies to Live View:

```text
Human clicks local Button
Human edits local Input
→ deterministic browser-local state change
→ no Room message by default
→ no new Agent turn by default
```

`Action != Cognition`: cognition runs only when an explicit Agent interaction
requires it.

## Live Transcript is shared context

Committed Live Transcript is Room-wide bounded shared context produced by one
Human-authorized STT-ready Runtime Host. It is infrastructure, not a permanent
meeting archive, and transcript visibility does not itself wake an Agent.

See [Live Transcript](../guides/live-transcript).

## Bounded Room context vs Harness memory

Free4Chat keeps shared context bounded. Anything a participant needs beyond
the Room lifetime belongs on the participant side: durable memory, repository
state, local files, external storage, or another explicitly exported artifact.

Do not confuse a retained Harness Task session with permanent Room history.
The Harness may keep private cognition context while the Room still owns only
bounded shared facts.

## Related pages

- [Rooms and ownership](room) - ownership split in one page.
- [Runtime and Harness](runtime-harness) - Room/Task cognition boundaries.
- [Tasks and Live Views](../guides/tasks-and-live-views) - Human-facing Task
  workflow.
- [Cross-machine Agent collaboration](../guides/cross-machine-collaboration) -
  requests, results, and artifacts in a real flow.
