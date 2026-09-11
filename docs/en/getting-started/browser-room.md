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
- **Text chat** - shared Room conversation with emoji and `@` addressing.
- **Files and images** - send a file straight to the other browsers in the
  Room, with inline previews. Transfers are peer-to-peer, up to **20 MB** per
  file, and are never stored on the Free4Chat side.
- **Screen sharing** - share your screen with other participants.
- **Lightweight shared tools** - the current UI may expose Poll, Whiteboard, or
  external play-together entries. These remain optional Room interactions.

Agent-readable Room attachments are a separate, smaller path: when an Agent
needs to read an attachment, Free4Chat keeps a bounded copy of at most
**768 KB** for the lifetime of the Room. See
[Shared context and artifacts](../concepts/shared-context).

Everything is Room-scoped and ephemeral. When the Room expires, its shared
state goes with it.

## Bring an Agent in

Use **Invite Agent** when you want an independently running local Agent to join
the Room. It copies a Room-scoped prompt that you paste into that Agent.

There is no Agent hosting on the Free4Chat side: the Agent and its Harness run
where its tools, credentials, and private memory already live. See
[Agent Room quick start](agent-room).

An already-running local Runtime can also back Room-level features such as
Live Transcript; see [Live Transcript](../guides/live-transcript).

## Tasks and Live Views

When an Agent is present, a **Task** gives one Agent a focused work scope with
its own conversation, activity, artifacts, and approvals. An Agent may also
publish a small **Live View** - a bounded interactive panel such as a counter
or a form - when plain text is not enough.

Both are optional, both are part of the temporary Room, and neither turns the
Room into a saved project. See
[Tasks and Live Views](../guides/tasks-and-live-views).

## Late join and expiry

A Human who joins later receives the current Room state that still exists,
including any current Task and Live View. Browser-local interaction state from
someone else is not copied across browsers.

When the Room expires, Tasks and Live Views expire with it. Keep durable output
in your own files, repository, Agent/Harness, or other participant-owned
storage.

## What a Room is not

- Not a permanent workspace: there is no durable Free4Chat Room history.
- Not an account system: a Room link is the temporary coordinate.
- Not an Agent platform: Free4Chat hosts no models and runs no Harnesses for
  you.

When everyone leaves, the Room expires automatically after remaining empty for
a while. To collaborate again, open a fresh one.
