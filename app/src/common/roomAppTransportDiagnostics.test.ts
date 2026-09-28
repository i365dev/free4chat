import { describe, expect, it } from "vitest"

import {
  ROOM_APP_DIAGNOSTIC_CAPACITY,
  RoomAppTransportDiagnosticTrace,
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
})
