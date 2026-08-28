import { describe, expect, it } from "vitest"

import {
  ANALYTICS_PROPERTY_KEYS,
  createCollabAnalyticsTracker,
  roomComposition,
  resolveParticipantKind,
  type CollabAnalyticsContext,
} from "./collabAnalytics"
import type { CollabEvent } from "../room/types"

const ROOM_TYPE = "audio"
const ROOM_HASH = "a1b2c3d4"

function context(
  participants: CollabAnalyticsContext["participants"],
  overrides: Partial<CollabAnalyticsContext> = {}
): CollabAnalyticsContext {
  return {
    roomType: ROOM_TYPE,
    roomHash: ROOM_HASH,
    participants,
    selfPeerId: "local-peer-id",
    selfParticipantId: "raw-self-id",
    ...overrides,
  }
}

const HUMAN = { peerId: "raw-self-id", kind: "human" as const }
const AGENT = { peerId: "agent-1", kind: "agent" as const }

function collabEvent(overrides: Partial<CollabEvent>): CollabEvent {
  return {
    requestId: "req-1",
    kind: "request",
    fromParticipantId: "raw-self-id",
    targetParticipantId: "agent-1",
    ...overrides,
  }
}

describe("AgentJoined presence analytics", () => {
  it("emits for a newly present Agent and not for ordinary Human presence", () => {
    const tracker = createCollabAnalyticsTracker()

    const humanOnly = tracker.observePresence(context([HUMAN]))
    expect(humanOnly).toEqual([])

    const withAgent = tracker.observePresence(context([HUMAN, AGENT]))
    expect(withAgent).toHaveLength(1)
    expect(withAgent[0]).toEqual({
      roomType: ROOM_TYPE,
      roomHash: ROOM_HASH,
      participantBucket: "2-3",
      roomComposition: "human-agent",
    })
  })

  it("does not re-emit for replayed, re-observed, or reconnected presence", () => {
    const tracker = createCollabAnalyticsTracker()
    expect(tracker.observePresence(context([HUMAN, AGENT]))).toHaveLength(1)

    // Same roster observed again (re-render / state refresh / replay).
    expect(tracker.observePresence(context([HUMAN, AGENT]))).toEqual([])

    // Reconnect: roster momentarily empties, then the same Agent returns.
    expect(tracker.observePresence(context([HUMAN]))).toEqual([])
    expect(tracker.observePresence(context([HUMAN, AGENT]))).toEqual([])

    // A genuinely different Agent participant is a new, distinct join.
    const second = tracker.observePresence(
      context([HUMAN, AGENT, { peerId: "agent-2", kind: "agent" }])
    )
    expect(second).toHaveLength(1)
    expect(second[0]?.roomComposition).toBe("mixed")
    expect(second[0]?.participantBucket).toBe("2-3")
  })
})

describe("CollabRequested / CollabOutcome analytics", () => {
  it("emits exactly one CollabRequested per canonical request", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const first = tracker.observeCollabEvent(ctx, collabEvent({}))
    expect(first).toEqual({
      name: "CollabRequested",
      properties: {
        roomType: ROOM_TYPE,
        roomHash: ROOM_HASH,
        requesterKind: "human",
        targetKind: "agent",
        roomComposition: "human-agent",
      },
    })

    // Room state refresh / resync replay re-delivers the same envelope.
    expect(tracker.observeCollabEvent(ctx, collabEvent({}))).toBeNull()
    expect(tracker.observeCollabEvent(ctx, collabEvent({ ...{} }))).toBeNull()
  })

  it("emits agent-to-agent requester and target kinds", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([AGENT, { peerId: "agent-2", kind: "agent" }])

    const emitted = tracker.observeCollabEvent(
      ctx,
      collabEvent({
        fromParticipantId: "agent-1",
        targetParticipantId: "agent-2",
      })
    )
    expect(emitted).toEqual({
      name: "CollabRequested",
      properties: expect.objectContaining({
        requesterKind: "agent",
        targetKind: "agent",
        roomComposition: "agent-only",
      }),
    })
  })

  it("maps terminal kinds to CollabOutcome outcomes exactly once", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const declined = tracker.observeCollabEvent(
      ctx,
      collabEvent({ kind: "declined" })
    )
    expect(declined).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({ outcome: "declined" }),
    })
    expect(
      tracker.observeCollabEvent(ctx, collabEvent({ kind: "declined" }))
    ).toBeNull()

    const completed = tracker.observeCollabEvent(
      ctx,
      collabEvent({ requestId: "req-2", kind: "completed" })
    )
    expect(completed).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({ outcome: "completed" }),
    })

    const failed = tracker.observeCollabEvent(
      ctx,
      collabEvent({ requestId: "req-3", kind: "failed" })
    )
    expect(failed).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({ outcome: "failed" }),
    })
    expect(
      tracker.observeCollabEvent(
        ctx,
        collabEvent({ requestId: "req-3", kind: "failed" })
      )
    ).toBeNull()
  })

  it("sets hasArtifact only from attachment presence, never contents", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const withArtifact = tracker.observeCollabEvent(
      ctx,
      collabEvent({
        requestId: "req-a",
        kind: "completed",
        attachmentIds: ["att-1"],
      })
    )
    expect(withArtifact).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({
        outcome: "completed",
        hasArtifact: true,
      }),
    })

    const withoutArtifact = tracker.observeCollabEvent(
      ctx,
      collabEvent({ requestId: "req-b", kind: "completed" })
    )
    expect(withoutArtifact).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({
        outcome: "completed",
        hasArtifact: false,
      }),
    })
  })

  it("never emits for the intermediate accepted kind", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    expect(
      tracker.observeCollabEvent(ctx, collabEvent({ kind: "accepted" }))
    ).toBeNull()
  })

  it("emits an outcome even if the request envelope was never observed", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    const outcome = tracker.observeCollabEvent(
      ctx,
      collabEvent({ kind: "completed" })
    )
    expect(outcome).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({ outcome: "completed" }),
    })
    // And the later replayed request envelope does not emit retroactively.
    expect(tracker.observeCollabEvent(ctx, collabEvent({}))).toBeNull()
  })
})

describe("analytics privacy shape", () => {
  it("sends only the agreed coarse properties, never private content", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const presence = tracker.observePresence(ctx)
    for (const payload of presence) {
      expect(Object.keys(payload)).toEqual([
        ...ANALYTICS_PROPERTY_KEYS.AgentJoined,
      ])
    }

    const requested = tracker.observeCollabEvent(
      ctx,
      collabEvent({
        requestId: "raw-request-id",
        summary: "please deploy the secret feature",
        details: { command: "rm -rf /" },
      })
    )
    expect(requested).not.toBeNull()
    expect(Object.keys(requested!.properties)).toEqual([
      ...ANALYTICS_PROPERTY_KEYS.CollabRequested,
    ])

    const outcome = tracker.observeCollabEvent(
      ctx,
      collabEvent({
        requestId: "raw-request-id",
        kind: "completed",
        summary: "deployed the secret feature",
        details: { url: "https://internal.example.invalid" },
        attachmentIds: ["att-raw-id"],
      })
    )
    expect(outcome).not.toBeNull()
    expect(Object.keys(outcome!.properties)).toEqual([
      ...ANALYTICS_PROPERTY_KEYS.CollabOutcome,
    ])

    const serialized = JSON.stringify([presence, requested, outcome])
    for (const secret of [
      "raw-request-id",
      "secret feature",
      "rm -rf",
      "internal.example",
      "att-raw-id",
      "agent-1",
      "raw-self-id",
      "test-room-name",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("keeps unresolvable participant ids out of payloads", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN])
    const emitted = tracker.observeCollabEvent(
      ctx,
      collabEvent({
        fromParticipantId: "gone-agent",
        targetParticipantId: "gone-agent",
      })
    )
    expect(emitted).toEqual({
      name: "CollabRequested",
      properties: expect.objectContaining({
        requesterKind: "unknown",
        targetKind: "unknown",
        roomComposition: "human-only",
      }),
    })
  })
})

describe("pure helpers", () => {
  it("buckets room composition by participant kinds", () => {
    expect(roomComposition([HUMAN])).toBe("human-only")
    expect(roomComposition([AGENT])).toBe("agent-only")
    expect(roomComposition([HUMAN, AGENT])).toBe("human-agent")
    expect(
      roomComposition([HUMAN, AGENT, { peerId: "agent-2", kind: "agent" }])
    ).toBe("mixed")
  })

  it("resolves the local Human from either its roster entry or raw id", () => {
    const ctx = context([AGENT])
    expect(resolveParticipantKind(ctx, "raw-self-id")).toBe("human")
    expect(resolveParticipantKind(ctx, "local-peer-id")).toBe("human")
    expect(resolveParticipantKind(ctx, "agent-1")).toBe("agent")
    expect(resolveParticipantKind(ctx, "unknown-id")).toBe("unknown")
  })
})
