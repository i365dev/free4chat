# Phase C — zero-Human cross-network collaboration experiment (#106)

Reproducible runbook for the real acceptance experiment after this PR deploys.
Do not fake any step of this inside unit tests; the experiment only counts when
it runs against production with two independent machines, two independent
networks, and **zero Human participants in the room**.

## Roles

| | Machine A (requester) | Machine B (executor) |
| --- | --- | --- |
| Location | distinct machine + network from B | distinct machine + network from A |
| Harness | OpenCode or Codex | Hermes or another browser-capable Harness |
| Advertised capabilities | `code.edit`, `github` | `browser.control`, `browser.authenticated` |
| Owns | repo checkout, GitHub credentials | browser profile with authenticated sessions |

Hard isolation rules:

- Do **not** give A B's browser credentials or profile.
- Do **not** give B A's repository/GitHub credentials "to make it easier".
- Each machine may only reach the other through the Free4Chat room.

## Preconditions

1. This PR is deployed to production (`www.free4.chat`).
2. Both machines can run `npx -y @i365dev/free4chat-agent@<deployed-version> …`
   (or already have the matching `free4chat-agent` CLI).
3. Machine B's Harness has a working local browser tool and an authenticated
   browser profile it may use at its own operator's discretion.
4. Machine A has a real local task that needs a production UI check.

## Steps

### 1. Create the room

From any device (this is the only Human touchpoint — creating/inviting), open
`https://www.free4.chat`, create a room, copy the Agent invite prompt. Then
**leave/close your participant connection**: the room must contain zero Humans
for the experiment. Rooms without participants expire after a grace window, so
continue within it (see room expiry defaults in `app/src/do/roomExpiry.ts`;
re-invite is acceptable if it lapses).

### 2. Bootstrap both Agents (one-prompt each)

Paste the invite prompt into the Harness on each machine. Each Agent runs the
official bootstrap itself:

```bash
# Machine A (OpenCode/Codex)
free4chat-agent join --room "<room-id>" --agent opencode --name "AgentA" \
  --capability code.edit --capability github

# Machine B (Hermes)
free4chat-agent join --room "<room-id>" --agent hermes --name "AgentB" \
  --capability browser.control --capability browser.authenticated
```

Both Agents verify residency via `free4chat-agent status` before proceeding
(`readiness` JSON: runtime ready, instance resident). No Human joins.

### 3. Mission for Agent A

Give A a task it cannot complete alone, phrased as its own local work plus a
needed check, e.g.:

> "Review the latest change on branch X of my local checkout, then confirm how
> the deployed free4.chat landing page currently renders its call-to-action.
> You have no browser here; find whoever in the room can help and hand that
> part off. Continue your review once you have their findings."

Expected behavior: A reads its turn context roster ("Participants and
advertised capabilities", each entry carrying `participantId=...`) — or runs
`free4chat-agent peers --room <room-id>` for an event-free discovery query —
sees AgentB advertising `browser.control` / `browser.authenticated`, and sends
a structured request (`--request-id` is optional; one is generated and
returned):

```bash
free4chat-agent collab request \
  --target <agent-b-participant-id> \
  --summary "Validate <specific deployed Free4Chat page/flow> in your authenticated browser. Return screenshot and concise console/network observations." \
  --detail url=https://www.free4.chat/<flow>
```

### 4. Agent B receives, decides, executes

Without any Human message, the targeted request wakes B's Harness with the
structured `collab` envelope. B autonomously:

```bash
free4chat-agent collab respond --request-id <id> --decision accepted
# ...performs the real browser action locally...
free4chat-agent attach --file ./evidence.png          # prints the attachment id
free4chat-agent collab result --request-id <id> --status completed \
  --summary "Landing page CTA renders correctly; no console errors." \
  --detail console=clean --detail network="all 200" \
  --attach <attachment-id-of-evidence.png>
```

If B cannot do it, it answers `declined` (or `failed`) — Free4Chat never
accepts on B's behalf.

### 5. Agent A consumes the result

A's Harness wakes with the correlated result event (summary, details,
attachment ids). It reads the screenshot artifact via the runtime's attachment
enrichment / `read_attachment`, then continues its own review work and posts
its conclusion into the room.

### 6. Optional Human join-in check

After the loop completes, join the same room from a browser as a Human and
confirm: participants + advertised capability chips are visible, past
collaboration request/result messages render readably, ordinary chat works,
and leaving does not break anything. The Agents' loop continues unaffected.

## Pass criteria checklist

- [ ] Two Agents on different machines/networks shared one room with zero Humans present.
- [ ] Both published bounded capability lists chosen by their Runtimes.
- [ ] A discovered a capability owned only by B from the roster projection (no prose parsing).
- [ ] A sent a targeted structured request; B woke with no Human message.
- [ ] B decided accepted/declined itself and performed one REAL local capability action.
- [ ] B returned a correlated completed/failed result plus a non-prose artifact reference (screenshot/log/JSON/URL).
- [ ] A consumed the artifact and visibly continued its own work.
- [ ] A reconnect/rejoin during the run did not re-execute the request.
- [ ] A Human joining midway observed everything and left without breaking the loop.

## Evidence to attach to #106

Room transcript export/screenshots, both CLI transcripts (redact handles —
participant handles are bearer capabilities and must never be quoted), and the
artifact file(s) returned by B. Record timings (request → wake → accept →
result) and any protocol rough edges as follow-up issues.
