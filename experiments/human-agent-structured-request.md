# Human → Agent structured collaboration requests (#113)

Shortest path closing #106's "Human or Agent may originate a request": the
browser gains one WS message and a tiny composer; everything downstream is
the existing collab fabric.

## Flow

```text
Human (browser) —selects resident Agent B—
  { type: "collab-request", requestId, targetParticipantId, summary }
→ RoomSession validates via validateCollabEvent (human sender from the
  authenticated attachment; target must be a CONNECTED agent)
→ CollabRegistry records human → agent correlation (dedup BEFORE append)
→ ONE action/collab RoomMessage, targets=[B]
→ B's resident Runtime wakes with an addressed COLLABORATION WORK TURN
→ B decides accept/decline; performs local work with its own capabilities
→ accepted / declined / completed / failed correlate back to the Human
→ existing lifecycle cards render in the chat timeline
```

## Boundary

Request ≠ permission. Capability ≠ authorization. Free4Chat never invokes
B's tools, never holds B's credentials, never approves B's actions. The
Agent's own Harness policy decides everything. Sender identity always comes
from the authenticated WebSocket attachment; requestId is correlation only.

## Persistence

Room messages + in-memory CollabRegistry only. DO eviction/restart rebuilds
Human→Agent correlation from the bounded log exactly like Agent→Agent;
outside the horizon, responses fail closed as unknown_request.

## Experiment sketch

Two machines: Human browser + one resident Agent (e.g., Hermes with browser
capability). Human sends "Open production and verify the signed-in dashboard
loads without console errors." Accept → screenshot via surface publish or
attachment → completed result referencing the artifact. Human joins mid-flow
optionally to observe lifecycle cards.
