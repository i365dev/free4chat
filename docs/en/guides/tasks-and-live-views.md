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

## Starting a Task

Start Task gives one Agent one focused piece of work.

By default a Task starts a **new Harness session**, so the Agent begins with the
Task brief rather than with an unrelated earlier conversation.

Some Harnesses also support **continuing an existing local session**. When the
Harness you selected has *verified* session continuation, Start Task offers a
session choice:

```text
New session      → the Task starts a fresh Harness conversation
Continue session → the Task continues an existing local Harness session
```

The choice appears only for a Harness where continuation has actually been
verified end to end. Free4Chat does not offer it for a Harness that merely
advertises the capability.

Session discovery is **local and private**, and it is lazy:

- nothing is read from your machine merely because you opened Start Task;
- the local session list is requested only when you explicitly open the
  continuation path;
- what you see is discovery metadata for the participating Agent, not a
  shared Room artifact, and it is not published to other participants.

If a continuation start does not succeed, no Task is created; Start Task stays
open with your instruction instead of silently falling back to a new session.

## Large initial briefs

You can paste a substantial brief directly into Start Task. A real handoff —
specs, logs, a long prompt — does not have to be sent as a separate follow-up
message after creating an empty Task.

When the pasted text is larger than the inline instruction field comfortably
holds, Free4Chat keeps it as **bounded Task-scoped context** instead of
truncating it:

```text
Start Task
→ short instruction stays the Task instruction
→ oversized pasted brief becomes bounded Task-scoped context
→ the canonical Task is created with that context already attached
→ the Agent's first turn already has the brief
```

The exact text is preserved as an attachment on the Task; it is not summarised,
rewritten, or silently shortened, and it becomes an ordinary Room-level artifact
only if you deliberately attach something to the Room instead.

If that context cannot be staged, the Task is **not** started and your text
stays in the dialog, so a Task never begins with missing context.

The bounded limits for text-like Task context are the same ones described under
[Task attachments vs ordinary Room file transfer](#task-attachments-vs-ordinary-room-file-transfer)
below (currently 768 KB for text-like content).

## Long-running and resumable supervision

A Task may run for a long time — many minutes or longer — and you do not have to
keep watching it.

The browser connection is **not** the owner of local Agent execution:

```text
closing or leaving the Room/browser
→ does not by itself cancel a running local Task

returning later
→ Free4Chat reconciles bounded coarse Task execution state
→ Task controls are available again
```

On return you get a truthful, bounded picture rather than a live replay. The
states you may see include:

- **Starting** / **Working** — the Task is being set up, or an Agent is working;
- **Running** — an Agent turn is executing right now;
- **Queued** — accepted work is waiting for execution capacity;
- **Interrupted** — the active turn was stopped;
- **Completed** / **Failed** — the Task reached a terminal outcome;
- **Session lost** — the retained Harness conversation for this Task is gone.

An approval card waiting for your decision is shown as a card in the Task, not as
a special Task status.

Two different things are deliberately kept apart:

```text
Human/browser disconnect
→ local Runtime/Harness may keep executing; the Task can continue

local Runtime/Harness process death
→ continuous execution is NOT promised
```

Free4Chat does not provide durable execution across a local process, daemon, or
machine shutdown. If the local execution died, the Task reflects that truthfully
(for example `Session lost` or `Interrupted`) instead of pretending it kept
running, and you can decide how to continue.

Everything here stays inside the temporary Room: it still expires normally, and
the browser coming back does not make the Room permanent.

## Controlling a running Task

While a Task has an active turn, the Task offers explicit controls.

**Interrupt** stops the exact turn that is running for that Task. It does not
affect other Tasks, and it does not cancel work that already finished.

**Interrupt & send** is one action, not two. Your typed replacement instruction is
kept first, and the currently running turn is then interrupted:

```text
Interrupt & send
→ your replacement instruction is preserved as Task input
→ the current turn is stopped when it is still the active one
→ the replacement becomes the Task's next instruction
```

If the turn you were reacting to had already finished, the action is not an
error: your instruction is still accepted as the next Task instruction, nothing
later is cancelled, and the Task continues normally.

## Execution capacity

Different Tasks belonging to the same Agent do not fight over one conversation:

```text
per native Harness session  → always serialized (at most one turn at a time)

independent Tasks           → may make bounded concurrent progress
                              only where that Harness has been verified safe
```

Concurrency is an explicitly verified capability, not a general promise. Not
every built-in Harness supports running independent Tasks at the same time, and
Free4Chat never enables it merely because a Harness can hold several sessions.

When execution capacity is full, further accepted work is shown as **Queued** —
waiting for an execution lane — rather than appearing stuck or silently dropped.

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
→ bounded external shared-surface host
```

Free4Chat provides only the sandbox, trusted-origin, and transport boundary for
such surfaces. The separate Extension Lab owns the curated App portfolio and
its runtime/discovery lifecycle; this is not a general-purpose plugin SDK.

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
