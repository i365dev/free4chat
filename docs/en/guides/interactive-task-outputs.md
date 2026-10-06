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

When a Task uses this surface, the Agent returns one complete self-contained
HTML document between the terminal Task-output markers. It does not serialize
an internal JSON bundle. The Runtime parses the HTML5 document and normalizes
it into the existing Generated Room App bundle before the usual validation and
Task publication.

The V1 source subset requires exactly one non-empty `<title>`, a `<head>`, and
a `<body>`. Put zero or more inline `<style>` elements in `<head>` and zero or
one classic inline `<script>` as the final meaningful child of `<body>`. The
script may be omitted. External scripts, modules, `async`/`defer`, executable
scripts in `<head>`, external stylesheets, and other external resource
dependencies are not supported. The Runtime derives the App title from
`<title>`, uses an empty initial state, and keeps `networkOrigins` empty.
Author normal markup, CSS, and JavaScript directly; quotes and backslashes do
not need JSON escaping.

For example, the payload between the markers can be:

```html
<!doctype html>
<html>
<head>
  <title>Printer</title>
  <style>body { font: 16px sans-serif; }</style>
</head>
<body>
  <h1>Printer</h1>
  <p>Status: <span id="status">Loading</span></p>
  <button id="refresh">Refresh</button>
  <script>
    document.querySelector("#refresh").addEventListener("click", async () => {
      const result = await free4chat.capabilities.observe("printer_status");
      document.querySelector("#status").textContent = result.ok
        ? JSON.stringify(result.value)
        : result.error;
    });
  </script>
</body>
</html>
```

It is not general app hosting, a backend runtime, or a way to publish a local
service. Exact publication commands and protocol limits belong in the
[CLI reference](../reference/cli) and [MCP Room API](../reference/mcp).

### Using a Runtime local capability

When the originating Runtime has projected a local semantic capability into
the Task context, a Generated Task App may call
`free4chat.capabilities.observe(id)` or
`free4chat.capabilities.invoke(id, action, args)`. A participant's
`--capability` advertisement is discovery metadata; it is not this Runtime
descriptor and grants no authority. The capability descriptor also does not
authorize an operation by itself.

Each operation must come from one explicit trusted Human control click and is
limited to that deterministic operation. It runs through the existing
Human↔originating-Agent private reliable participant lane to the Runtime and
its external Adapter; it does not start another Harness/LLM turn. The result
is bounded semantic data returned to the same App. If the Runtime or Adapter
has departed or is unavailable, the call fails closed. The iframe receives no
Adapter configuration, device endpoint/URI, queue name, hostname/IP,
credentials, or Runtime host/session/routing identity.

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

- [Building a three-button remote with a Generated Task App](https://www.bmpi.dev/en/dev/free4chat-task-app-development-notes/)
  — an end-to-end case study.
- [Agent Tasks](tasks-and-live-views) - start work, leave, return, and supervise.
- [Browser Room quick start](../getting-started/browser-room) - create a Room.
- [Shared context and artifacts](../concepts/shared-context) - what is shared
  and what expires.
- [Room Apps](/apps) - browse existing shared tools and activities.
