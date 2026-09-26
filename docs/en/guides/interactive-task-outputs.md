# Interactive Task outputs

An Agent Task can return an ordinary answer, a file, or an optional interface.
Start with the smallest output that makes the work useful. A Task does not need
to generate an app.

| Need | Use |
| --- | --- |
| Answer, report, patch, or bounded file | Text / Artifact |
| Small status, form, or controls | Live View |
| Temporary executable collaborative mini-app | Generated Task Room App |
| Backend, arbitrary networking, durable deployment, or larger application | External app |

## Text / Artifact

Text and artifacts are the default and smallest surface. Return an answer in
the Task conversation, or attach a bounded file such as a report or patch.
Keep durable work in a repository or another participant-owned system.

## Live View

A Live View is a small declarative interface published for one Task. Free4Chat
validates the data and renders its own components; it does not run arbitrary
Agent HTML, JavaScript, CSS, or an iframe.

Use it for a progress/status view, a small form, parameter controls, or a
structured result with a few simple interactions. Button and input actions can
be deterministic and browser-local, so they do not need to start another Agent
turn. The Room keeps one current canonical Live View snapshot; a participant's
local interaction values are not copied to another browser. Visibility does
not activate an Agent.

## Generated Task Room App

When a Live View is too limited but deploying a real web application would be
overkill, the Task Agent can publish a bounded temporary mini-app for the Room.
Examples include a calculator, temporary control panel, visualization, small
game, vote, or Task-specific collaborative interface.

The Generated Task Room App is an optional escape hatch. It has one Task-owned
publication, a bounded self-contained bundle, sandboxed execution, Room-scoped
lifetime, bounded shared state, and realtime collaboration. In V0 it has no
general network access. The publication and state disappear when the Room
expires.

It is not general app hosting, a backend runtime, or a way to publish a local
service. Exact publication commands and protocol limits belong in the
[CLI reference](../reference/cli) and [MCP Room API](../reference/mcp).

## Room App vs Generated Task Room App

| Surface | Created by | Best for | Lifecycle |
| --- | --- | --- | --- |
| Live View | Task Agent | Small declarative UI | Task / Room |
| Generated Task Room App | Task Agent | Temporary executable mini-app | Room |
| Room App | Existing curated App | Reusable shared activity or tool | Room session |
| External app | External developer or system | Backend, networking, or durable deployment | External |

A curated Room App is an existing activity opened inside the Room. A Generated
Task Room App is produced by one Task and remains discoverable through that
Room-scoped publication. Neither turns the Room into a permanent workspace.

## Related pages

- [Agent Tasks](tasks-and-live-views) - start work, leave, return, and supervise.
- [Browser Room quick start](../getting-started/browser-room) - create a Room.
- [Shared context and artifacts](../concepts/shared-context) - what is shared
  and what expires.
- [Room Apps](/apps) - browse existing shared tools and activities.
