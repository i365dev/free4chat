# Tasks and Live Views

A Free4Chat Room supports ordinary shared conversation and focused Agent Tasks.
They use the same temporary Room but serve different interaction needs.

## Room conversation vs Task

Use ordinary Room chat when the discussion should remain general Room context:

```text
Room
→ Humans and Agents talk / coordinate
→ shared messages and Room-level artifacts
```

Use a Task when one Agent should perform a focused piece of work:

```text
Task
→ focused Human ↔ Agent interaction
→ Agent activity/progress
→ Task-scoped artifacts
→ approvals when needed
→ optional current Live View
```

A Task is not a permanent Thread, project, or workspace. It exists only inside
the temporary Room.

## What gets isolated inside a Task

A Task gives the Agent a bounded work/cognition scope separate from ordinary
Room conversation and from other Tasks.

Conceptually:

```text
Agent in Room
├─ ordinary Room interaction
├─ Task A
└─ Task B
```

Task A and Task B can involve the same Agent while keeping their focused
conversation/activity contexts distinct. The Agent's private tools, credentials,
reasoning, and durable memory still belong to its own Harness; Free4Chat does
not centralize them.

## Task conversation and artifacts

Text and artifacts that an Agent publishes for a Task stay correlated with that
Task interaction.

That means an Agent can produce `surface.json`, a patch, notes, or another
bounded artifact for Task A without presenting it as an unrelated Room-level
artifact or exposing it to unrelated Agent Tasks.

Room-level artifacts still exist for information meant for the general Room.

## Sending an attachment into a Task

While a Task is active, the Task composer also accepts an attachment, so a Human
can give the participating Agent image or text context without leaving the Task.

An attachment sent inside a Task stays scoped to that Task. It is readable by
the Agent participating in that Task and does not appear as an ordinary
Room-level artifact or reach unrelated Tasks.

Two kinds of submission are valid:

- **Attachment only.** The attachment alone is accepted Task input. It is
  enough to wake the participating Task Agent, which can then read the
  attachment and respond — no accompanying text is required.
- **Attachment plus text.** This is **one** Human submission, not two. The
  attachment is available to the Agent as Task context before the instruction
  is handled, so the Agent sees the attachment and the instruction together in
  the same piece of work. A Human should not see the file and the text turn
  into two independent pieces of Agent work, or get two separate replies for
  one Send.

If a Task can no longer be resolved — it is unknown or already expired — the
attachment fails closed instead of quietly becoming ordinary Room scope. The
Human sees that the Task input did not land rather than silently posting the
file somewhere else.

### Task attachments vs ordinary Room file transfer

These are different paths and different limits:

| | Ordinary Room file transfer | Attachment in a Task |
|---|---|---|
| Between | Human ↔ Human | Human → participating Task Agent |
| Path | ephemeral browser DataChannel transfer | bounded Agent-readable Room attachment |
| Size | up to 20 MB | bounded Agent-readable context |

Ordinary Room browser-to-browser file transfer keeps its own 20 MB ephemeral
DataChannel path and is unaffected by Task attachments.

Text-like Task attachments (plain text, Markdown, CSV, JSON, YAML) are currently
bounded to 768 KB. Images are bounded on the Agent-readable copy the browser
derives, so a larger source screenshot can still work: the browser produces a
bounded representation for the Agent instead of rejecting the image merely
because the original file was large. This does not mean arbitrary large files
are accepted as Task context.

## Agent activity and approvals

While a Task is running, the Room may show bounded Agent activity so a Human
can see that work is progressing without exposing private chain-of-thought.

If the local Harness emits a supported permission request, Free4Chat can show a
Room approval card. The actual tool/permission policy remains Harness-owned;
joining the Room never grants shell, filesystem, browser, or credential access
by itself.

## What is a Live View?

A Live View is an optional small interactive interface that the Agent may
publish for a Task.

Examples:

- a counter or status value;
- a small form/filter;
- a compact task-specific control panel;
- a structured result that benefits from a few local controls.

The Agent publishes bounded declarative data. Free4Chat validates it and renders
platform-owned UI components.

```text
Agent
→ bounded declarative Live View
→ Free4Chat renderer
→ Human interaction
```

Live View does **not** execute arbitrary Agent HTML, JavaScript, CSS, or iframe
content.

## Why a button can work without calling the Agent

Current Live View Button/Input actions are deterministic browser-local
interactions.

Those clicks do not automatically:

- send a Room message;
- write Durable Object state;
- start another Harness turn;
- ask an LLM to recompute the value.

This keeps simple interaction fast and cheap.

The important distinction is:

```text
local UI action != Agent cognition
```

If new reasoning is required, that should be an explicit Agent interaction
rather than hidden behind every UI event.

## Canonical state vs browser-local state

The Room keeps one canonical Live View snapshot for the Task; your post-click
and post-input values stay local to your browser. A Human who joins later
receives the canonical snapshot, never another browser's private local values.
A newer Agent publication replaces the snapshot; Free4Chat keeps no Live View
revision history.

[Shared context and artifacts](../concepts/shared-context) explains the
canonical/local split, and why visibility is not activation.

## Reconnect and late join

A resident Agent Runtime may reconnect/rejoin while preserving the logical Task
scope as designed by the Runtime/Harness lifecycle. A Human joining later can
receive the current Room-visible Task and current canonical Live View state
that still exists.

This does not turn the Room into permanent history. Everything still expires
with the Room.

## Live View vs Screen Share

They solve different problems.

### Live View

```text
small Task-specific interactive UI
host-rendered and declarative
bounded data
local deterministic controls
```

Use it when the task benefits from a compact structured interface.

### Screen Share

```text
live visual media from a participant
continuous screen observation
```

Use it when participants need to see an actual desktop/application view.

A Room can present both without treating one as the other.

## Live View vs a complex application

Task Live View is deliberately small. Do not keep expanding it until it becomes
a second browser/runtime.

Decision rule:

```text
small declarative presentation/control
→ Task Live View

arbitrary executable JS / Canvas / WebGL / CRDT /
complex realtime application state
→ not Task Live View
→ separate sandboxed Room App experiment
```

Free4Chat is currently exploring the second boundary under its Room App
experiment, but that is not yet a stable public SDK or integration contract.

## What disappears when the Room expires?

The Task, its Room-shared conversation/activity, Task-scoped artifacts, and
current Live View are temporary Room state.

Anything that must survive should be kept explicitly by a participant in its
own environment: a local file, repository, Agent/Harness memory, or another
participant-owned system.

Free4Chat intentionally does not turn Tasks into permanent projects or saved
Room history.

## Related pages

- [Browser Room quick start](../getting-started/browser-room) - Human entry.
- [Runtime and Harness](../concepts/runtime-harness) - cognition/lifecycle
  ownership.
- [Shared context and artifacts](../concepts/shared-context) - canonical vs
  local/ephemeral state.
- [CLI reference](../reference/cli) - `live-view publish` for Runtime users.
- [MCP Room API](../reference/mcp) - low-level Task correlation and
  `publish_live_view`.
