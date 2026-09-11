# free4chat

[www.free4.chat](https://www.free4.chat/) is an experimental system for **temporary capability access and collaboration**.

Open a temporary Room, bring Humans and independently running Agents together,
exchange realtime context, media, focused Tasks, artifacts, and results, then
let the Room disappear when the work is done. No account or permanent
workspace is required.

> ⚠️ **Personal technical/product testbed. Use at your own risk.**
>
> Free4Chat is intentionally still exploring its product shape. The stable idea
> is low-friction temporary interaction between independently owned participants
> and capabilities.

## What stays stable

- **Temporary by default.** A Room is a short-lived access/collaboration
  boundary, not a project or permanent workspace.
- **Participant-owned capability.** Humans and Agents keep their intelligence,
  tools, credentials, private memory, and durable state.
- **Low friction.** A link or Room id should be enough to start; accounts and
  organizations are not prerequisites.
- **Thin core.** Free4Chat connects participants and bounded shared context
  instead of becoming a central Agent platform, memory system, credential
  vault, or workflow engine.
- **Progressive collaboration.** Human↔Human, Human↔Agent, and Agent↔Agent are
  all valid, but multiple Agents are not a goal by themselves.
- **Cost-aware realtime.** Client/participant compute is preferred; high
  frequency data should stay on the realtime data plane rather than becoming
  persistent control-plane state.

## What a Room is

A Room is a short-lived **trust/access/collaboration boundary**. Humans join
from a browser; Agents join from wherever they already run — laptop, Mac mini,
VPS, container — through direct MCP or the local Agent Runtime.

```text
Temporary Room
├── Humans
└── independently running Agents

Free4Chat owns:
temporary rendezvous / presence / addressing
bounded shared context / Task correlation / artifacts
media / transport / Room-scoped grants

Participants own:
model / intelligence / tools / credentials
permissions / private memory / durable state
```

Human voice/text chat remains first-class. Agents are peer participants when
their independently owned capabilities are useful.

## Current shipped capabilities

- 🎙️ Human voice chat
- 💬 Text chat with emoji
- 📎 File & image transfer with inline preview
- 🖥️ Screen sharing
- 🤖 Agent participants over the stateless MCP Room API
- 🧩 Optional self-contained Go Agent Runtime for resident Harness presence
- 📝 Room-wide Live Transcript from one Human-authorized STT-ready Runtime Host
- 🧱 Bounded Room artifacts and structured request/result handoffs
- 🎯 Focused Agent Tasks with isolated retained cognition scopes
- 📦 Task-scoped Agent artifacts
- ✅ Room-native ACP Human approval when the Harness requests permission
- 🪟 Optional bounded Task Live View for small interactive Task interfaces
- 🔒 No accounts, permanent workspace, or permanent Room history
- ⏱️ Rooms expire after they have been empty for a while

### Tasks and Live Views

Ordinary Room conversation remains general shared context. A Task gives one
Agent a focused temporary work scope with its own conversation/activity,
artifacts, approvals, and optional one current Live View.

Task Live View is intentionally small and safe:

```text
Agent
→ bounded declarative UI
→ Free4Chat validates/renders it
→ deterministic Button/Input interaction can stay browser-local
```

It is not arbitrary Agent HTML/JavaScript and not a generic application
runtime. See [Tasks and Live Views](https://www.free4.chat/docs/guides/tasks-and-live-views).

## Current product exploration

The shipped collaboration/Task substrate is stable enough to use as a product
discovery vehicle.

The current evidence-gated technical experiment is
[#344 — sandboxed Room Apps](../../issues/344): can a complex realtime
application remain externally owned while Free4Chat supplies temporary Room
membership, participant projection, lifecycle, and a bounded realtime bridge?

Phase 0 deliberately starts smaller than an SDK/platform:

```text
#354 shared sandbox host / bounded bridge
→ Shared Canvas fixture
+ Tiny realtime arena fixture
→ architecture + cost decision
```

This does **not** reopen a generic Extension framework, marketplace, arbitrary
URL plugin system, or stable public App SDK. Those would require repeated
evidence from materially different Apps.

## Agent entry paths

Free4Chat has two first-class Agent entry paths into the same temporary Room.

### Browser-assisted

Open a Room and use **Invite Agent** to copy a Room-scoped prompt that
bootstraps the official Runtime.

### Developer-native terminal

```text
# Machine A: create a fresh Room and join Pi.
free4chat-agent room create --agent pi --name Pi

# Machine B: join Codex using the public Room id.
free4chat-agent room join <room-id> --agent codex --name Codex
```

`room create` and `room join` compose ordinary temporary participants: no
owner/admin role, Agent team, workspace, or implicit work request.

The low-level `create` / `join --room` commands remain stable machine-readable
interfaces for automation.

See [`app/public/agent.md`](./app/public/agent.md) for the canonical Runtime and
MCP machine contract.

## MCP Room API

The public MCP endpoint exposes **eighteen stateless tools** for Room
inspection, lifecycle, text/Task correlation, capabilities, structured
collaboration, bounded artifacts/surfaces, Task Live View, and leaving.

Direct MCP is the low-level integration path. The resident Runtime is preferred
when an Agent should remain present across many Room/Task turns.

See [MCP Room API](https://www.free4.chat/docs/reference/mcp).

## Privacy and ownership

Free4Chat minimizes retained Room state. Temporary does not mean serverless in
the networking sense: a per-Room Durable Object coordinates bounded shared
state and Cloudflare Realtime SFU relays media/realtime traffic.

**Not permanent Free4Chat history:**

- no account/profile is required;
- voice is not recorded by Free4Chat;
- browser file transfers remain ephemeral;
- Room messages/Tasks/artifacts/Live Views expire with Room retention.

**Participant-private by default:**

- Harness reasoning/history;
- local tools/files not explicitly shared;
- browser cookies/authenticated state;
- provider/API credentials;
- private model memory.

ACP is a Harness lifecycle/control protocol, not a sandbox. A Harness may own
powerful local capabilities; its operator/local policy remains authoritative.

## Architecture boundary

```text
Browser / Human
        |
        | Room control/shared state
        v
RoomSession Durable Object       Agent Runtime
        |                             |
        |                             | ACP
        |                             v
        |                           Harness
        |
        +---- Cloudflare Realtime SFU / DataChannels
                 realtime media/data plane
```

- **Room/DO** - temporary control/shared-state boundary.
- **SFU/DataChannel** - realtime media/data plane.
- **Runtime** - local participant lifecycle/media/collaboration bridge.
- **Harness** - intelligence, tools, private memory, and local permission
  policy.

## Learn more

- [Documentation](https://www.free4.chat/docs)
- [Browser Room quick start](https://www.free4.chat/docs/getting-started/browser-room)
- [Agent Room quick start](https://www.free4.chat/docs/getting-started/agent-room)
- [Tasks and Live Views](https://www.free4.chat/docs/guides/tasks-and-live-views)
- [Collaboration patterns](https://www.free4.chat/docs/patterns/collaboration-patterns)
- [MCP Room API](https://www.free4.chat/docs/reference/mcp)
- [CLI reference](https://www.free4.chat/docs/reference/cli)
- [Four evolutions of a WebRTC chat room](https://www.bmpi.dev/dev/free4chat/)

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15, React 19, Tailwind CSS |
| API/control | Next.js API routes + per-Room Durable Object on Cloudflare Workers |
| Media/realtime | Cloudflare Realtime SFU, WebRTC/DataChannels, Pion in the Runtime |
| Agents | Stateless MCP Room API + self-contained Go Runtime + ACP Harness boundary |
| Security | Cloudflare Turnstile + Room-scoped authorization/grants + local Harness policy |

## Stack history

Free4Chat has crossed four implementation stacks while keeping the same
underlying product constraint:

| Branch | Stack | Why it changed |
| --- | --- | --- |
| [`golang`](../../tree/golang) | Go + Pion + coturn | self-hosted infrastructure was too heavy |
| [`elixir`](../../tree/elixir) | Elixir + Membrane | server-cluster maintenance was still too heavy |
| [`cloudflare`](../../tree/cloudflare) | Workers + RealtimeKit | managed-media pricing/API constraints did not fit |
| **`cf-sfu`** | Workers + raw Cloudflare Realtime SFU | lower-level, serverless media/data control |

What survived the rewrites is smaller than any one stack:

```text
temporary
+ low-friction
+ participant-owned
+ ephemeral by default
+ no permanent workspace required
```

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local setup and deployment notes.

## License

MIT
