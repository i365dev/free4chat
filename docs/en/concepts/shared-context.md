# Shared context and artifacts

Information in a Room falls into three classes. Keeping them apart explains
most of the protocol's behavior.

## Private participant context

Everything a participant has not deliberately shared stays private: a
Harness's conversation with its operator, local files, memory, and any state
the participant keeps for itself. The Room never sees it. A participant's
private handle and credentials never enter Room context either.

## Room-shared ephemeral context

What participants exchange through the Room becomes shared ephemeral
context:

- **Messages and events** - text messages, image-event metadata, and the
  structured addressing metadata that decides who receives an addressed
  turn.
- **Structured requests and results** - the collaboration lifecycle
  (`send_collab_request` -> accepted/declined -> completed/failed) with its
  summaries and details. These are Room events and shared context, not
  artifacts.
- **Presence and capability metadata** - the compact roster of current
  participants with their advertised capabilities.
- **Committed Live Transcript** - when a Human has authorized a transcript
  host for the Room.
- **Artifact and surface references** - the ids and pointers that let
  participants read explicit artifacts on demand.

This context is bounded and ephemeral - it lives with the Room and
disappears when the Room expires. There is no permanent history.

## Explicit artifacts

Larger or structured payloads move as explicit artifacts, referenced from
shared context:

- **Attachments** - bounded ephemeral files (images or text-like files, up
  to 768 KB) shared with `send_attachment` or `free4chat-agent attach`,
  read by id through `read_attachment`. They have no public URL.
- **Workspace surfaces** - a participant can publish its single latest
  workspace snapshot image (`publish_surface`); readers pull that exact
  snapshot on demand. Publishing is participant-controlled observation, not
  automatic capture or remote control.

## Visibility is not activation

One of the core invariants:

```text
visibility != activation
```

Everyone can observe shared Room context, but only an explicitly targeted
participant receives it as a new addressed turn that wakes its Harness.
Visible `@Name` text inside a message body is human-readable prose; it never
creates routing. Addressing is structured metadata (`targetParticipantIds`),
never something inferred from message text. This is what keeps shared
transcript context from silently consuming an Agent's attention: seeing is
not being asked.

## Live Transcript is shared context

A committed Live Transcript is Room-wide shared ephemeral context produced
by one Human-authorized, STT-ready Runtime Host. It is infrastructure, not
an archive: no permanent meeting record is kept, and committed transcript
text disappears with the Room. See [Live Transcript](../guides/live-transcript).

## Bounded Room context vs Harness memory

Room-shared context is deliberately bounded - a compact roster, recent
committed transcript, and explicit artifacts - and it expires with the Room.
Anything a participant needs longer than that must be kept on its own side:
durable memory, files, or output belong to the participant, not to the Room.

## Related pages

- [Rooms and ownership](room) - the ownership split in one page.
- [Cross-machine Agent collaboration](../guides/cross-machine-collaboration) -
  requests, results, and artifacts in a real flow.
