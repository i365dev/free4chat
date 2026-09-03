import { describe, expect, it, vi, afterEach } from "vitest"

import {
  buildAgentJoinedEvent,
  buildTargetedMessageEvent,
  buildCollabRequestedEvent,
  buildCollabOutcomeEvent,
  buildCollaborationDurationEvent,
  importAnalyticsEvents,
  mixpanelImportRow,
  hashRoom as hashRoomServer,
  APPROVED_ANALYTICS_PROPERTIES,
  type RoomAnalyticsEvent,
} from "./roomAnalytics"
import { hashRoom } from "../common/utils"

const PARTICIPANTS = [
  {
    id: "human-1",
    kind: "human" as const,
    name: "Human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: "tok-human",
  },
  {
    id: "agent-pi",
    kind: "agent" as const,
    name: "Pi",
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: "tok-pi",
  },
  {
    id: "agent-codex",
    kind: "agent" as const,
    name: "Codex",
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: "tok-codex",
  },
]

describe("room analytics builders (#228)", () => {
  it("AgentJoined carries only approved properties", () => {
    const event = buildAgentJoinedEvent({
      roomName: "test",
      participants: PARTICIPANTS,
    })
    expect(event.name).toBe("AgentJoined")
    expect(Object.keys(event.properties).sort()).toEqual(
      [...APPROVED_ANALYTICS_PROPERTIES.AgentJoined].sort()
    )
    expect(event.properties.roomHash).toBe(hashRoom("test"))
    expect(event.properties.roomComposition).toBe("mixed")
    expect(event.properties.participantBucket).toBe("2-3")
  })

  it("CollabRequested resolves original requester/target kinds", () => {
    const event = buildCollabRequestedEvent({
      roomName: "test",
      participants: PARTICIPANTS,
      fromParticipantId: "human-1",
      targetParticipantId: "agent-pi",
    })
    expect(event.name).toBe("CollabRequested")
    expect(event.properties.requesterKind).toBe("human")
    expect(event.properties.targetKind).toBe("agent")
  })

  it("CollabOutcome reverses topology and reports hasArtifact", () => {
    const event = buildCollabOutcomeEvent({
      roomName: "test",
      participants: PARTICIPANTS,
      kind: "completed",
      // Result envelopes reverse direction: from=responder(agent), target=
      // original requester(human). The board's topology must stay
      // requester=human / target=agent.
      fromParticipantId: "agent-pi",
      targetParticipantId: "human-1",
      attachmentIds: ["att-1"],
    })
    expect(event.properties.outcome).toBe("completed")
    expect(event.properties.requesterKind).toBe("human")
    expect(event.properties.targetKind).toBe("agent")
    expect(event.properties.hasArtifact).toBe(true)
  })

  it("server hashRoom matches the browser hashRoom convention exactly", () => {
    for (const name of ["test", "free4chat2", "", "房间-名称", "a.b-c_d:e"]) {
      expect(hashRoomServer(name)).toBe(hashRoom(name))
    }
  })
})

describe("Mixpanel /import ingestion (#228)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("builds the proven import row shape", () => {
    const event: RoomAnalyticsEvent = buildCollabRequestedEvent({
      roomName: "test",
      participants: PARTICIPANTS,
      fromParticipantId: "human-1",
      targetParticipantId: "agent-pi",
    })
    const row = mixpanelImportRow(event, 1234, "insert-1")
    expect(row.event).toBe("CollabRequested")
    const properties = row.properties as Record<string, unknown>
    expect(properties.time).toBe(1234)
    expect(properties.distinct_id).toBe("server:free4chat")
    expect(properties.$insert_id).toBe("insert-1")
    expect(properties.ip).toBe(0)
    // Only approved properties ride.
    expect(
      Object.keys(properties)
        .filter((k) => !["time", "distinct_id", "$insert_id", "ip"].includes(k))
        .sort()
    ).toEqual([...APPROVED_ANALYTICS_PROPERTIES.CollabRequested].sort())
  })

  it("absent token is a silent no-op", async () => {
    const fetchImpl = vi.fn()
    await importAnalyticsEvents(
      [buildAgentJoinedEvent({ roomName: "test", participants: PARTICIPANTS })],
      undefined,
      fetchImpl as unknown as typeof fetch,
      Date.now()
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("Mixpanel failure is a harmless no-op", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"))
    await expect(
      importAnalyticsEvents(
        [
          buildAgentJoinedEvent({
            roomName: "test",
            participants: PARTICIPANTS,
          }),
        ],
        "token",
        fetchImpl as unknown as typeof fetch,
        Date.now()
      )
    ).resolves.toBeUndefined()
  })

  it("authenticates with Basic token and posts the import rows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    await importAnalyticsEvents(
      [buildAgentJoinedEvent({ roomName: "test", participants: PARTICIPANTS })],
      "project-token",
      fetchImpl as unknown as typeof fetch,
      1700000000000
    )
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.mixpanel.com/import?strict=1")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Basic " + btoa("project-token:"),
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].event).toBe("AgentJoined")
  })
})

describe("CollaborationDuration event (#228 extension)", () => {
  it("carries roomHash plus the approved property set", () => {
    const event = buildCollaborationDurationEvent({
      roomName: "test",
      durationMs: 240_000,
      collaborationMode: "human-agent",
      participantBucket: "2-3",
    })
    expect(event.name).toBe("CollaborationDuration")
    expect(event.properties.roomHash).toBe(hashRoom("test"))
    expect(event.properties.durationMs).toBe(240_000)
    expect(event.properties.collaborationMode).toBe("human-agent")
    expect(event.properties.participantBucket).toBe("2-3")
    expect(Object.keys(event.properties).sort()).toEqual(
      [...APPROVED_ANALYTICS_PROPERTIES.CollaborationDuration].sort()
    )
  })
})

describe("TargetedMessage analytics (#234)", () => {
  const room = { roomName: "test", participants: PARTICIPANTS }

  it("Human→Agent single target: senderKind human, targetKind agent, bucket 1", () => {
    const event = buildTargetedMessageEvent({
      ...room,
      senderParticipantId: "human-1",
      targetParticipantIds: ["agent-pi"],
    })
    expect(event.name).toBe("TargetedMessage")
    expect(event.properties).toEqual({
      roomType: "unknown",
      roomHash: hashRoom("test"),
      senderKind: "human",
      targetKind: "agent",
      targetCountBucket: "1",
      roomComposition: "mixed",
    })
  })

  it("Agent→Agent: senderKind agent, targetKind agent", () => {
    const event = buildTargetedMessageEvent({
      ...room,
      senderParticipantId: "agent-pi",
      targetParticipantIds: ["agent-codex"],
    })
    expect(event.properties.senderKind).toBe("agent")
    expect(event.properties.targetKind).toBe("agent")
    expect(event.properties.targetCountBucket).toBe("1")
  })

  it("multi-target text uses exactly one event with a count bucket, never N", () => {
    const event = buildTargetedMessageEvent({
      ...room,
      senderParticipantId: "human-1",
      targetParticipantIds: ["agent-pi", "agent-codex"],
    })
    expect(event.properties.targetCountBucket).toBe("2-3")
    // One event per canonical message is enforced at the mutation boundary;
    // the builder itself produces a single event object.
    expect(event.name).toBe("TargetedMessage")
  })

  it("mixed Human+Agent targets resolve to mixed targetKind (protocol invariant today)", () => {
    const event = buildTargetedMessageEvent({
      ...room,
      senderParticipantId: "human-1",
      targetParticipantIds: ["agent-pi", "human-1"],
    })
    expect(event.properties.targetKind).toBe("mixed")
  })

  it("resolved targets only use approved properties and keep server identity", () => {
    const event = buildTargetedMessageEvent({
      ...room,
      senderParticipantId: "agent-pi",
      targetParticipantIds: ["agent-codex"],
    })
    expect(Object.keys(event.properties).sort()).toEqual(
      [...APPROVED_ANALYTICS_PROPERTIES.TargetedMessage].sort()
    )
    const row = mixpanelImportRow(event, 1234, "insert-1")
    const props = row.properties as Record<string, unknown>
    expect(row.event).toBe("TargetedMessage")
    expect(props.distinct_id).toBe("server:free4chat")
    expect(props.$insert_id).toBe("insert-1")
    expect(props.ip).toBe(0)
    // No participant ids/names, message text, or content can ride the row.
    const serialized = JSON.stringify(row)
    expect(serialized.includes("agent-pi")).toBe(false)
    expect(serialized.includes("Pi")).toBe(false)
    expect(serialized.includes("token")).toBe(false)
  })

  it("unresolved sender stays unknown without inventing a kind", () => {
    const event = buildTargetedMessageEvent({
      ...room,
      senderParticipantId: "gone-participant",
      targetParticipantIds: ["agent-pi"],
    })
    expect(event.properties.senderKind).toBe("unknown")
  })
})
