import { describe, expect, it } from "vitest"

import {
  ANALYTICS_PROPERTY_KEYS,
  createCollabAnalyticsTracker,
  delegationTopology,
  roomComposition,
  resolveParticipantKind,
  type CollabAnalyticsContext,
} from "./collabAnalytics"
import type { CollabEvent, CollabEventKind } from "../room/types"

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
const AGENT_2 = { peerId: "agent-2", kind: "agent" as const }

/**
 * Production routing shape (do/collab.ts): a request travels from the
 * original requester to the original target, while the canonical registry
 * rewrites every response/result envelope in the reverse direction —
 * from=responder (the original target), target=the original requester.
 */
function requestEnvelope(overrides: Partial<CollabEvent> = {}): CollabEvent {
  return {
    requestId: "req-1",
    kind: "request",
    fromParticipantId: "raw-self-id",
    targetParticipantId: "agent-1",
    ...overrides,
  }
}

function terminalEnvelope(
  kind: Extract<CollabEventKind, "declined" | "completed" | "failed">,
  overrides: Partial<CollabEvent> = {}
): CollabEvent {
  return {
    requestId: "req-1",
    kind,
    fromParticipantId: "agent-1",
    targetParticipantId: "raw-self-id",
    ...overrides,
  }
}

describe("AgentJoined presence analytics", () => {
  it("does not count Agents of the initial snapshot, then emits genuinely new joins once", () => {
    const tracker = createCollabAnalyticsTracker()

    // Before the connection is established the roster is observed without
    // baseline semantics: nothing may emit yet.
    expect(tracker.observePresence(context([HUMAN, AGENT]))).toEqual([])

    // Initial post-join snapshot: Agents already present are baselined
    // silently instead of being counted as having just joined.
    expect(
      tracker.observePresence(
        context([HUMAN, AGENT], { presenceBaseline: true })
      )
    ).toEqual([])

    // Replays/re-renders of the baselined roster stay silent.
    expect(
      tracker.observePresence(
        context([HUMAN, AGENT], { presenceBaseline: true })
      )
    ).toEqual([])

    // A genuinely new Agent after observation began emits exactly once.
    const joined = tracker.observePresence(
      context([HUMAN, AGENT, AGENT_2], { presenceBaseline: true })
    )
    expect(joined).toHaveLength(1)
    expect(joined[0]).toEqual({
      roomType: ROOM_TYPE,
      roomHash: ROOM_HASH,
      participantBucket: "2-3",
      roomComposition: "mixed",
    })

    // Reconnect-style replay of the same roster never re-emits.
    expect(
      tracker.observePresence(
        context([HUMAN, AGENT, AGENT_2], { presenceBaseline: true })
      )
    ).toEqual([])
  })

  it("baselines an initially empty room, so the first real Agent join emits", () => {
    const tracker = createCollabAnalyticsTracker()
    expect(
      tracker.observePresence(context([HUMAN], { presenceBaseline: true }))
    ).toEqual([])

    const joined = tracker.observePresence(
      context([HUMAN, AGENT], { presenceBaseline: true })
    )
    expect(joined).toHaveLength(1)
    expect(joined[0]?.roomComposition).toBe("human-agent")

    // The same Agent leaving and returning is not a second join.
    expect(tracker.observePresence(context([HUMAN]))).toEqual([])
    expect(tracker.observePresence(context([HUMAN, AGENT]))).toEqual([])
  })
})

describe("CollabRequested / CollabOutcome analytics", () => {
  it("emits exactly one CollabRequested per canonical request", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const first = tracker.observeCollabEvent(ctx, requestEnvelope(), Date.now())
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
    expect(
      tracker.observeCollabEvent(ctx, requestEnvelope(), Date.now())
    ).toBeNull()
  })

  it("keeps requester/target meaning the original delegation across outcomes", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    tracker.observeCollabEvent(ctx, requestEnvelope(), Date.now())

    // The terminal envelope reverses direction (the responder is the Agent);
    // analytics must still report the ORIGINAL Human -> Agent delegation.
    const outcome = tracker.observeCollabEvent(
      ctx,
      terminalEnvelope("completed"),
      Date.now()
    )
    expect(outcome).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({
        outcome: "completed",
        requesterKind: "human",
        targetKind: "agent",
      }),
    })
  })

  it("emits agent-to-agent requester and target kinds", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([AGENT, AGENT_2])

    const emitted = tracker.observeCollabEvent(
      ctx,
      requestEnvelope({
        fromParticipantId: "agent-1",
        targetParticipantId: "agent-2",
      }),
      Date.now()
    )
    expect(emitted).toEqual({
      name: "CollabRequested",
      properties: expect.objectContaining({
        requesterKind: "agent",
        targetKind: "agent",
        roomComposition: "agent-only",
      }),
    })

    // The Agent-to-Agent outcome keeps the same original topology.
    const outcome = tracker.observeCollabEvent(
      ctx,
      terminalEnvelope("declined", {
        fromParticipantId: "agent-2",
        targetParticipantId: "agent-1",
      }),
      Date.now()
    )
    expect(outcome).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({
        outcome: "declined",
        requesterKind: "agent",
        targetKind: "agent",
      }),
    })
  })

  it("never emits for the intermediate accepted kind", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    expect(
      tracker.observeCollabEvent(
        ctx,
        requestEnvelope({ kind: "accepted" }),
        Date.now()
      )
    ).toBeNull()
  })

  it("emits an outcome even if the request envelope was never observed", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    const outcome = tracker.observeCollabEvent(
      ctx,
      terminalEnvelope("completed"),
      Date.now()
    )
    expect(outcome).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({ outcome: "completed" }),
    })
    // And the later replayed request envelope does not emit retroactively.
    expect(
      tracker.observeCollabEvent(ctx, requestEnvelope(), Date.now())
    ).toBeNull()
  })
})

describe("historical Room state baseline", () => {
  it("stays silent for envelopes created before observation began", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    const historical = Date.now() - 60_000

    // Old request retained in Room state when the Human entered.
    expect(
      tracker.observeCollabEvent(ctx, requestEnvelope(), historical)
    ).toBeNull()
    // Its replays stay silent too.
    expect(
      tracker.observeCollabEvent(ctx, requestEnvelope(), historical)
    ).toBeNull()

    // Old terminal state is likewise never reattributed.
    expect(
      tracker.observeCollabEvent(ctx, terminalEnvelope("completed"), historical)
    ).toBeNull()
    expect(
      tracker.observeCollabEvent(ctx, terminalEnvelope("failed"), historical)
    ).toBeNull()

    // A genuinely new request after observation began emits exactly once.
    const fresh = tracker.observeCollabEvent(
      ctx,
      requestEnvelope({ requestId: "req-new" }),
      Date.now()
    )
    expect(fresh).toEqual({
      name: "CollabRequested",
      properties: expect.objectContaining({ requesterKind: "human" }),
    })
    expect(
      tracker.observeCollabEvent(
        ctx,
        requestEnvelope({ requestId: "req-new" }),
        Date.now()
      )
    ).toBeNull()
  })

  it("does not reattribute retained history across a page reload", () => {
    // A reload creates a fresh tracker (new observation clock); the retained
    // lifecycle is again older than the boundary and stays silent.
    const reloadedTracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])
    expect(
      reloadedTracker.observeCollabEvent(
        ctx,
        requestEnvelope({ requestId: "req-old" }),
        Date.now() - 60_000
      )
    ).toBeNull()
    expect(
      reloadedTracker.observeCollabEvent(
        ctx,
        terminalEnvelope("completed", { requestId: "req-old" }),
        Date.now() - 60_000
      )
    ).toBeNull()
  })
})

describe("hasArtifact", () => {
  it("reflects attachment presence only, never contents", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const withArtifact = tracker.observeCollabEvent(
      ctx,
      terminalEnvelope("completed", { attachmentIds: ["att-1"] }),
      Date.now()
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
      terminalEnvelope("failed", { requestId: "req-2" }),
      Date.now()
    )
    expect(withoutArtifact).toEqual({
      name: "CollabOutcome",
      properties: expect.objectContaining({
        outcome: "failed",
        hasArtifact: false,
      }),
    })
  })
})

describe("analytics privacy shape", () => {
  it("sends only the agreed coarse properties, never private content", () => {
    const tracker = createCollabAnalyticsTracker()
    const ctx = context([HUMAN, AGENT])

    const presence = tracker.observePresence(
      context([HUMAN, AGENT], { presenceBaseline: true })
    )
    for (const payload of presence) {
      expect(Object.keys(payload)).toEqual([
        ...ANALYTICS_PROPERTY_KEYS.AgentJoined,
      ])
    }

    const requested = tracker.observeCollabEvent(
      ctx,
      requestEnvelope({
        requestId: "raw-request-id",
        summary: "please deploy the secret feature",
        details: { command: "rm -rf /" },
      }),
      Date.now()
    )
    expect(requested).not.toBeNull()
    expect(Object.keys(requested!.properties)).toEqual([
      ...ANALYTICS_PROPERTY_KEYS.CollabRequested,
    ])

    const outcome = tracker.observeCollabEvent(
      ctx,
      terminalEnvelope("completed", {
        requestId: "raw-request-id",
        summary: "deployed the secret feature",
        details: { url: "https://internal.example.invalid" },
        attachmentIds: ["att-raw-id"],
      }),
      Date.now()
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
      requestEnvelope({
        fromParticipantId: "gone-agent",
        targetParticipantId: "gone-agent",
      }),
      Date.now()
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
    expect(roomComposition([HUMAN, AGENT, AGENT_2])).toBe("mixed")
  })

  it("normalizes the reversed response/result envelope direction", () => {
    expect(delegationTopology(requestEnvelope())).toEqual({
      requesterId: "raw-self-id",
      targetId: "agent-1",
    })
    expect(delegationTopology(terminalEnvelope("completed"))).toEqual({
      requesterId: "raw-self-id",
      targetId: "agent-1",
    })
  })

  it("resolves the local Human from either its roster entry or raw id", () => {
    const ctx = context([AGENT])
    expect(resolveParticipantKind(ctx, "raw-self-id")).toBe("human")
    expect(resolveParticipantKind(ctx, "local-peer-id")).toBe("human")
    expect(resolveParticipantKind(ctx, "agent-1")).toBe("agent")
    expect(resolveParticipantKind(ctx, "unknown-id")).toBe("unknown")
  })
})
