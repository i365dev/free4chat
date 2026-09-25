import { describe, expect, it, vi, afterEach } from "vitest"

import {
  buildAgentJoinedEvent,
  buildRoomCreatedEvent,
  classifyRoomCreationSource,
  buildTargetedMessageEvent,
  buildCollabRequestedEvent,
  buildCollabOutcomeEvent,
  buildCollaborationDurationEvent,
  buildLiveViewPublishedEvent,
  buildGeneratedRoomAppPublishedEvent,
  buildTaskControlUsedEvent,
  isAnalyticsRoomId,
  permissionControlValue,
  taskDurationBucket,
  importAnalyticsEvents,
  mixpanelImportRow,
  hashRoom as hashRoomServer,
  APPROVED_ANALYTICS_PROPERTIES,
  type RoomAnalyticsEvent,
} from "./roomAnalytics"
import { hashRoom } from "../common/utils"

// #346: the canonical Room generation correlation id. Fixed here so the
// tests can prove the builders copy the PERSISTED value rather than
// minting their own.
const TEST_ANALYTICS_ROOM_ID = "3f7c1c2e-9a4b-4d5e-8f01-2b6c7d8e9f10"

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
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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

  it("LiveViewPublished carries only coarse approved properties", () => {
    for (const phase of ["first", "replacement"] as const) {
      const event = buildLiveViewPublishedEvent({
        roomName: "test",
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        phase,
      })
      expect(event.name).toBe("LiveViewPublished")
      expect(event.properties.phase).toBe(phase)
      expect(Object.keys(event.properties).sort()).toEqual(
        [...APPROVED_ANALYTICS_PROPERTIES.LiveViewPublished].sort()
      )
      const serialized = JSON.stringify(event.properties)
      expect(serialized).not.toContain("task-")
      expect(serialized).not.toContain("agent-")
      expect(serialized).not.toContain("Pi")
    }
  })

  it("generated Room App publication carries only coarse source/phase/size properties", () => {
    const event = buildGeneratedRoomAppPublishedEvent({
      roomName: "test",
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
      participants: PARTICIPANTS,
      phase: "update",
      bundleBytes: 12 * 1024,
    })
    expect(event.name).toBe("RoomAppPublished")
    expect(event.properties).toMatchObject({
      appSource: "generated",
      phase: "update",
      bundleSizeBucket: "4-16k",
    })
    expect(Object.keys(event.properties).sort()).toEqual(
      [...APPROVED_ANALYTICS_PROPERTIES.RoomAppPublished].sort()
    )
    expect(JSON.stringify(event.properties)).not.toContain("test-")
  })
})

describe("analyticsRoomId validation (#346)", () => {
  it("accepts exactly the shape crypto.randomUUID() produces", () => {
    expect(isAnalyticsRoomId(crypto.randomUUID())).toBe(true)
  })

  it("rejects anything that is not a UUID", () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      [],
      "",
      "test-room",
      // #346 non-negotiable: never derived from the Room name.
      hashRoom("test-room"),
      "3f7c1c2e-9a4b-4d5e-8f01-2b6c7d8e9f1",
      "3F7C1C2E-9A4B-4D5E-8F01-2B6C7D8E9F10",
      "3f7c1c2e9a4b4d5e8f012b6c7d8e9f10",
      "3f7c1c2e-9a4b-4d5e-8f01-2b6c7d8e9f10 ",
    ]) {
      expect(isAnalyticsRoomId(value)).toBe(false)
    }
  })
})

describe("Task duration bucketing (#346)", () => {
  it("uses coarse inclusive-lower bands and exact boundaries", () => {
    // Exact boundaries: 60s, 5m, 15m, 60m each land in the UPPER band.
    expect(taskDurationBucket(0)).toBe("<1m")
    expect(taskDurationBucket(59_999)).toBe("<1m")
    expect(taskDurationBucket(60_000)).toBe("1-5m")
    expect(taskDurationBucket(299_999)).toBe("1-5m")
    expect(taskDurationBucket(300_000)).toBe("5-15m")
    expect(taskDurationBucket(899_999)).toBe("5-15m")
    expect(taskDurationBucket(900_000)).toBe("15-60m")
    expect(taskDurationBucket(3_599_999)).toBe("15-60m")
    expect(taskDurationBucket(3_600_000)).toBe("60m+")
    expect(taskDurationBucket(86_400_000)).toBe("60m+")
  })

  it("returns undefined — never a fabricated band — for an underivable duration", () => {
    expect(taskDurationBucket(Number.NaN)).toBeUndefined()
    expect(taskDurationBucket(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(taskDurationBucket(-1)).toBeUndefined()
  })

  it("never emits raw milliseconds or timestamps, only the band", () => {
    const event = buildCollabOutcomeEvent({
      roomName: "test",
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
      participants: PARTICIPANTS,
      kind: "completed",
      fromParticipantId: "agent-pi",
      targetParticipantId: "human-1",
      requestCreatedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_000 + 7 * 60_000,
    })
    expect(event.properties.durationBucket).toBe("5-15m")
    expect(Object.keys(event.properties)).not.toContain("durationMs")
    expect(Object.keys(event.properties)).not.toContain("requestCreatedAt")
    expect(Object.keys(event.properties)).not.toContain("completedAt")
    expect(JSON.stringify(event.properties)).not.toContain("1700000000")
  })
})

describe("permission control classification (#346)", () => {
  it("maps ONLY the stable ACP option kinds to allow/reject", () => {
    expect(permissionControlValue("allow_once")).toBe("permission-allow")
    expect(permissionControlValue("allow_always")).toBe("permission-allow")
    expect(permissionControlValue("reject_once")).toBe("permission-reject")
    expect(permissionControlValue("reject_always")).toBe("permission-reject")
  })

  it("degenerates to one coarse value instead of guessing a semantic", () => {
    for (const kind of [
      undefined,
      null,
      "",
      "approve",
      "Allow",
      "allow_once ",
      "custom-harness-option",
      42,
    ]) {
      expect(permissionControlValue(kind)).toBe("permission-response")
    }
  })
})

describe("CollabOutcome product-value depth (#346)", () => {
  const base = {
    roomName: "test",
    analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
    participants: PARTICIPANTS,
    kind: "completed" as const,
    fromParticipantId: "agent-pi",
    targetParticipantId: "human-1",
  }

  it("preserves the existing hasArtifact semantics and the approved set", () => {
    const cases: Array<[string[] | undefined, boolean]> = [
      [undefined, false],
      [[], false],
      [["att-1"], true],
    ]
    for (const [attachmentIds, expected] of cases) {
      const event = buildCollabOutcomeEvent({ ...base, attachmentIds })
      expect(event.properties.hasArtifact).toBe(expected)
      expect(Object.keys(event.properties).sort()).toEqual(
        [...APPROVED_ANALYTICS_PROPERTIES.CollabOutcome]
          .filter((key) => key !== "durationBucket")
          .sort()
      )
    }
  })

  it("omits durationBucket entirely when the request timestamp is unrecoverable", () => {
    const event = buildCollabOutcomeEvent(base)
    expect(event.properties).not.toHaveProperty("durationBucket")
    // Still a complete, valid outcome.
    expect(event.properties.outcome).toBe("completed")
    expect(Object.keys(event.properties).sort()).toEqual(
      [...APPROVED_ANALYTICS_PROPERTIES.CollabOutcome]
        .filter((key) => key !== "durationBucket")
        .sort()
    )
  })

  it("defaults the Task-correlated output flags to false, never to a guess", () => {
    const event = buildCollabOutcomeEvent(base)
    expect(event.properties.hasLiveView).toBe(false)
    expect(event.properties.hasGeneratedApp).toBe(false)
  })

  it("reports output flags as booleans only — never an id or a payload", () => {
    const event = buildCollabOutcomeEvent({
      ...base,
      hasLiveView: true,
      hasGeneratedApp: true,
    })
    expect(event.properties.hasLiveView).toBe(true)
    expect(event.properties.hasGeneratedApp).toBe(true)
    const serialized = JSON.stringify(event.properties)
    expect(serialized).not.toContain("surface")
    expect(serialized).not.toContain("appInstanceId")
    expect(serialized).not.toContain("task-")
  })
})

describe("TaskControlUsed (#346)", () => {
  it("carries only the approved coarse control properties", () => {
    for (const control of [
      "interrupt",
      "interrupt-send",
      "session-continue",
      "permission-allow",
      "permission-reject",
      "permission-response",
    ] as const) {
      const event = buildTaskControlUsedEvent({
        roomName: "test",
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        control,
      })
      expect(event.name).toBe("TaskControlUsed")
      expect(event.properties.control).toBe(control)
      expect(event.properties.analyticsRoomId).toBe(TEST_ANALYTICS_ROOM_ID)
      expect(event.properties.roomHash).toBe(hashRoom("test"))
      expect(event.properties.roomComposition).toBe("mixed")
      expect(Object.keys(event.properties).sort()).toEqual(
        [...APPROVED_ANALYTICS_PROPERTIES.TaskControlUsed].sort()
      )
    }
  })

  it("never carries a Task, turn, session, participant, or content value", () => {
    const event = buildTaskControlUsedEvent({
      roomName: "test",
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
      participants: PARTICIPANTS,
      control: "interrupt-send",
    })
    const serialized = JSON.stringify(event)
    for (const prohibited of [
      "taskRequestId",
      "turnSequence",
      "requestId",
      "selectedOptionId",
      "sessionToken",
      "agent-pi",
      "human-1",
      "Pi",
      "tok-",
      "test-room",
    ]) {
      expect(serialized).not.toContain(prohibited)
    }
  })
})

describe("privacy / cardinality contract (#346)", () => {
  // Representative private values a real Room would hold. NONE of them may
  // ever reach an analytics payload.
  const ROOM_NAME = "secret-project-room"
  const PRIVATE_VALUES = [
    "secret-project-room",
    "agent-pi", // participant id
    "human-1",
    "Pi", // participant name / handle
    "tok-pi", // participant capability token
    "req-0f0f0f0f", // task request id
    "turn-42",
    "Summarize the confidential acquisition deck", // prompt/summary
    "quarterly-revenue.xlsx", // filename
    "att-0f0f", // attachment id
    "surface-counter", // Live View surface id
    "generated:11111111-1111-4111-8111-111111111111", // app instance id
    "<html>app source</html>", // generated App source
    "session-token-abc", // Runtime/Harness session token
    "provider-claim-xyz",
  ]

  function representativeEvents(): RoomAnalyticsEvent[] {
    return [
      buildRoomCreatedEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        creatorKind: "human",
        creationSource: "browser",
      }),
      buildAgentJoinedEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
      }),
      buildTargetedMessageEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        senderParticipantId: "human-1",
        targetParticipantIds: ["agent-pi", "agent-codex"],
      }),
      buildCollabRequestedEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        fromParticipantId: "human-1",
        targetParticipantId: "agent-pi",
      }),
      buildCollabOutcomeEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        kind: "completed",
        fromParticipantId: "agent-pi",
        targetParticipantId: "human-1",
        attachmentIds: ["att-0f0f"],
        requestCreatedAt: 1_700_000_000_000,
        completedAt: 1_700_000_000_000 + 61_000,
        hasLiveView: true,
        hasGeneratedApp: true,
      }),
      buildCollaborationDurationEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        durationMs: 240_000,
        collaborationMode: "human-agent",
        participantBucket: "2-3",
      }),
      buildLiveViewPublishedEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        phase: "first",
      }),
      buildGeneratedRoomAppPublishedEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        phase: "first",
        bundleBytes: 1024,
      }),
      buildTaskControlUsedEvent({
        roomName: ROOM_NAME,
        analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
        participants: PARTICIPANTS,
        control: "interrupt",
      }),
    ]
  }

  it("serializes representative payloads with no prohibited private value", () => {
    const events = representativeEvents()
    // Every canonical Room event is represented, and the schema freeze holds.
    expect(new Set(events.map((event) => event.name)).size).toBe(
      Object.keys(APPROVED_ANALYTICS_PROPERTIES).length
    )
    for (const event of events) {
      const serialized = JSON.stringify(
        mixpanelImportRow(event, 1_700_000_000_000, "insert-1")
      )
      for (const prohibited of PRIVATE_VALUES) {
        expect(serialized).not.toContain(prohibited)
      }
      // Only approved properties (plus the four ingest envelope fields) ride.
      const row = mixpanelImportRow(event, 1, "insert-1")
      const properties = row.properties as Record<string, unknown>
      expect(
        Object.keys(properties)
          .filter(
            (key) => !["time", "distinct_id", "$insert_id", "ip"].includes(key)
          )
          .sort()
      ).toEqual([...APPROVED_ANALYTICS_PROPERTIES[event.name]].sort())
      // The aggregate server identity is unchanged: no Room-scoped identity.
      expect(properties.distinct_id).toBe("server:free4chat")
    }
  })

  it("keeps analyticsRoomId the only high-cardinality correlation key", () => {
    for (const event of representativeEvents()) {
      expect(event.properties.analyticsRoomId).toBe(TEST_ANALYTICS_ROOM_ID)
      expect(event.properties.roomHash).toBe(hashRoom(ROOM_NAME))
      // Analytics must never derive the id from the Room name.
      expect(event.properties.analyticsRoomId).not.toBe(
        event.properties.roomHash
      )
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
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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
      [
        buildAgentJoinedEvent({
          roomName: "test",
          analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
          participants: PARTICIPANTS,
        }),
      ],
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
            analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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
      [
        buildAgentJoinedEvent({
          roomName: "test",
          analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
          participants: PARTICIPANTS,
        }),
      ],
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
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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
  const room = {
    roomName: "test",
    analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
    participants: PARTICIPANTS,
  }

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
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
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

describe("RoomCreated analytics (#234)", () => {
  it("carries exactly the approved coarse properties and server identity", () => {
    const event = buildRoomCreatedEvent({
      roomName: "test",
      analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
      creatorKind: "agent",
      creationSource: "agent-runtime",
    })
    expect(event.name).toBe("RoomCreated")
    expect(Object.keys(event.properties).sort()).toEqual(
      [...APPROVED_ANALYTICS_PROPERTIES.RoomCreated].sort()
    )
    expect(event.properties.roomHash).toBe(hashRoom("test"))
    expect(event.properties.creatorKind).toBe("agent")
    expect(event.properties.creationSource).toBe("agent-runtime")

    const row = mixpanelImportRow(event, 1234, "insert-1")
    const props = row.properties as Record<string, unknown>
    expect(props.distinct_id).toBe("server:free4chat")
    expect(props.ip).toBe(0)
    const serialized = JSON.stringify(row)
    expect(serialized.includes("participantId")).toBe(false)
    expect(serialized.includes("token")).toBe(false)
    expect(serialized.includes("test")).toBe(false)
  })

  it("supports the full creator-kind and source matrix", () => {
    for (const creatorKind of ["human", "agent"] as const) {
      for (const creationSource of [
        "browser",
        "agent-runtime",
        "mcp",
      ] as const) {
        const event = buildRoomCreatedEvent({
          roomName: "test",
          analyticsRoomId: TEST_ANALYTICS_ROOM_ID,
          creatorKind,
          creationSource,
        })
        expect(event.properties.creatorKind).toBe(creatorKind)
        expect(event.properties.creationSource).toBe(creationSource)
      }
    }
  })
})

describe("creationSource classification (#234)", () => {
  it("classifies the official Runtime User-Agent as agent-runtime", () => {
    expect(classifyRoomCreationSource("free4chat-agent/0.5.17")).toBe(
      "agent-runtime"
    )
    expect(
      classifyRoomCreationSource(
        "free4chat-agent/0.5.17 (darwin/arm64) node/v22"
      )
    ).toBe("agent-runtime")
  })

  it("classifies anything else as mcp and is case/absence tolerant", () => {
    expect(classifyRoomCreationSource("")).toBe("mcp")
    expect(classifyRoomCreationSource("curl/8.0")).toBe("mcp")
    expect(classifyRoomCreationSource("SuperAgent/1.0")).toBe("mcp")
  })
})
