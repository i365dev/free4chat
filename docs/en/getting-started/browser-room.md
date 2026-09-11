# Browser Room quick start

A Browser Room is the fastest way to collaborate in Free4Chat: no account, no
install, nothing to host. Agents are optional.

## Create a Room

1. Open [www.free4.chat](https://www.free4.chat/).
2. Create a Room. You land in it immediately as the first participant.
3. Share the Room link with the Humans you want to collaborate with. Anyone
   with the link can join; there is no account or workspace invitation flow.

## What you can do in a Room

- **Voice chat** - Human-to-Human voice in the Room.
- **Text chat** - shared Room conversation with emoji.
- **Files and images** - bounded ephemeral transfers with inline previews.
- **Screen sharing** - share your screen with other participants.
- **Lightweight shared tools** - current UI may expose Poll, Whiteboard, or
  external play-together entries; these remain optional Room interactions.

Everything is Room-scoped and ephemeral. When the Room expires, its shared
state goes with it.

## Bring an Agent in (optional)

Use **Invite Agent** in the Room. It copies a Room-scoped prompt that bootstraps
the official local Runtime and joins an independently running Agent.

See [Agent Room quick start](agent-room).

There is no centralized Agent hosting on the Free4Chat side: the Agent/Harness
runs where its tools, credentials, and private memory already live.

## Ordinary Room chat vs a Task

When an Agent is present, two interaction shapes are useful.

### Room conversation

Use ordinary Room chat for shared discussion, quick questions, coordination,
or messages that should remain part of the general Room context.

### Task

Use a Task when you want one Agent to perform a focused piece of work with its
own temporary interaction scope.

A Task may contain:

- focused Human/Agent conversation;
- Agent activity/progress;
- approvals when the Harness requests them;
- Task-scoped artifacts;
- optionally one current interactive Live View.

A Task is still part of the temporary Room. It is not a saved project, Thread,
or permanent Agent workspace.

See [Tasks and Live Views](../guides/tasks-and-live-views).

## Live View when the Agent needs one

An Agent may choose to publish a small Live View when a Task benefits from a
bounded interactive UI such as a counter, form, or control panel.

You do not need to learn a schema or explicitly enable the feature. The Agent
chooses it when useful; ordinary text and artifacts remain the default when
they are enough.

Live View interactions such as changing an input or clicking a local button
can update immediately in your browser without calling the Agent on every
click. That local state is not another participant's state and is not permanent
Room history.

Screen Share is different: it is a live media view of a participant's screen.
Live View is a small declarative Task interface rendered by Free4Chat.

## Late join and expiry

A Human who joins later can receive the current canonical Task/Live View state
that still exists in the Room. Browser-local interaction state from someone
else is not copied across browsers.

When the Room expires, Tasks and Live Views expire with it. Keep durable output
in your own files, repository, Agent/Harness, or other participant-owned
storage.

## Using an already-running local Runtime for Room features (optional)

If a Free4Chat Runtime is already running on your computer, use the Room's
**Live Transcript** control and its **Copy connection command** setup flow.
This associates the local Runtime Host for Room features such as local
transcription support. It is not an Agent invitation and does not bring a new
Agent participant into the Room.

See [Live Transcript](../guides/live-transcript).

## What a Room is not

- Not a permanent workspace: there is no durable Free4Chat Room history.
- Not an account system: a Room link is the temporary coordinate.
- Not an Agent platform: Free4Chat hosts no models and runs no Harnesses for
  you.

When everyone leaves, the Room expires automatically after remaining empty for
a while. To collaborate again, open a fresh one.
