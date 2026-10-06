import { describe, expect, it } from "vitest"

import {
  ROOM_APP_DIAGNOSTIC_CAPACITY,
  RoomAppTransportDiagnosticTrace,
  roomAppCapabilityRouteReason,
  whiteboardProtocolType,
} from "./roomAppTransportDiagnostics"

describe("local Room App transport diagnostics", () => {
  it("records only after opt-in, bounds events, and distinguishes session rotation", () => {
    const trace = new RoomAppTransportDiagnosticTrace(() => "browser-one")
    trace.setSnapshotProvider(() => ({
      localReliableState: "open",
      remoteReliablePeers: ["human-b"],
    }))
    trace.setParticipant("human-a")
    expect(trace.read()).toEqual([])
    expect(trace.current()).toMatchObject({
      browserId: "browser-one",
      participantId: "human-a",
      sessionEpoch: 1,
      remoteReliablePeers: ["human-b"],
    })

    trace.enable()
    for (let index = 0; index <= ROOM_APP_DIAGNOSTIC_CAPACITY; index++)
      trace.record({
        event: "reliable_sent",
        appInstanceId: "whiteboard:test",
        protocolType: "wb_summary",
      })
    expect(trace.read()).toHaveLength(ROOM_APP_DIAGNOSTIC_CAPACITY)
    trace.setParticipant("human-a")
    expect(trace.read().at(-1)).toMatchObject({
      event: "session_started",
      sessionEpoch: 2,
      participantId: "human-a",
    })
    trace.disable()
    trace.record({
      event: "remote_reliable_closed",
      peerParticipantId: "human-b",
    })
    expect(trace.read().at(-1)?.event).toBe("session_started")
    expect(
      new RoomAppTransportDiagnosticTrace(() => "browser-after-reload")
        .browserId
    ).not.toBe(trace.browserId)
  })

  it("uses a fixed protocol type and cannot expose payload text", () => {
    const trace = new RoomAppTransportDiagnosticTrace(() => "browser-one")
    trace.enable()
    const payload = {
      type: "wb_elements",
      text: "PRIVATE_BOARD_TEXT_DO_NOT_TRACE",
      participantToken: "SECRET",
    }
    trace.record({
      event: "reliable_received",
      appInstanceId: "whiteboard:test",
      protocolType: whiteboardProtocolType(payload),
    })
    expect(trace.read().at(-1)?.protocolType).toBe("other")
    expect(JSON.stringify(trace.read())).not.toContain(payload.text)
    expect(JSON.stringify(trace.read())).not.toContain(payload.participantToken)
    expect(whiteboardProtocolType({ type: "wb_join" })).toBe("wb_join")
  })

  it("reports the first failed capability route precondition", () => {
    const readyRoute = {
      agentFound: true,
      publisherReady: true,
      peerConnectionState: "connected",
      subscriberSessionPresent: true,
      publisherSessionPresent: true,
      laneState: "open" as const,
      encoded: true,
    }
    expect(
      roomAppCapabilityRouteReason({
        ...readyRoute,
        publisherReady: false,
        laneState: "absent",
      })
    ).toBe("agent_transport_not_ready")
    expect(
      roomAppCapabilityRouteReason({ ...readyRoute, laneState: "absent" })
    ).toBe("direct_lane_absent")
    expect(roomAppCapabilityRouteReason(readyRoute)).toBeNull()
  })

  it("keeps local epochs monotonic without returning the private identity", () => {
    const trace = new RoomAppTransportDiagnosticTrace(() => "browser-one")
    expect(trace.nextLaneEpoch("publisher", "private-agent-id")).toBe(1)
    expect(trace.nextLaneEpoch("publisher", "private-agent-id")).toBe(2)
    trace.enable()
    trace.record({
      event: "lane_transition",
      lane: "participant_direct_reliable",
      transition: "ready",
      publisherEpoch: trace.laneEpoch("publisher", "private-agent-id"),
    })
    expect(JSON.stringify(trace.read())).not.toContain("private-agent-id")
    expect(trace.read().at(-1)?.publisherEpoch).toBe(2)
  })
})
