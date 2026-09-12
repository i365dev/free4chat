import { describe, expect, it } from "vitest"

import {
  ROOM_APP_CATALOG,
  ROOM_APP_LOCAL_CATALOG,
  ROOM_APP_MAX_PAYLOAD_BYTES,
  decodeRoomAppClientMessage,
  decodeRoomAppEnvelope,
  decodeRoomAppUnicastEnvelope,
  decodeRoomAppUnicastResult,
  encodeRoomAppUnicastRequest,
  encodeRoomAppEnvelope,
  isRoomAppInstanceForRoom,
  isRoomAppAllowlisted,
  projectRoomAppParticipants,
  roomAppRateGuard,
  roomAppUnicastRateGuard,
  roomAppInstanceId,
  resolveProductionRoomAppId,
  validateRoomAppDefinition,
} from "./roomApp"

describe("Room App Phase 0 bridge contract", () => {
  it("exposes only Whiteboard in production and keeps Phase-0 apps local", () => {
    expect(ROOM_APP_CATALOG).toEqual([
      {
        id: "whiteboard",
        label: "Whiteboard",
        url: "https://room-apps.free4.chat/whiteboard",
        origin: "https://room-apps.free4.chat",
      },
    ])
    expect(ROOM_APP_LOCAL_CATALOG.map((app) => app.id)).toEqual([
      "shared-canvas",
      "tiny-arena",
    ])
  })

  it("resolves direct launch by exact curated production id only", () => {
    expect(resolveProductionRoomAppId("whiteboard")).toBe("whiteboard")
    expect(resolveProductionRoomAppId("shared-canvas")).toBeNull()
    expect(resolveProductionRoomAppId("https://example.com/app")).toBeNull()
    expect(resolveProductionRoomAppId(["whiteboard"])).toBeNull()
    expect(resolveProductionRoomAppId("unknown")).toBeNull()
  })

  it("accepts only curated app definitions and rejects arbitrary origins", () => {
    expect(
      validateRoomAppDefinition({
        id: "shared-canvas",
        label: "Shared Canvas",
        url: "https://room-apps.free4.chat/shared-canvas",
        origin: "https://room-apps.free4.chat",
      })
    ).toBe(true)
    expect(isRoomAppAllowlisted(ROOM_APP_CATALOG[0])).toBe(true)
    expect(
      isRoomAppAllowlisted({
        id: "user-app",
        label: "User app",
        url: "https://evil.example/app",
        origin: "https://room-apps.free4.chat",
      })
    ).toBe(false)
  })

  it("keeps transport envelopes bounded and UTF-8 sized", () => {
    const encoded = encodeRoomAppEnvelope({
      appInstanceId: "shared-canvas:abc123",
      lane: "reliable",
      payload: { type: "stroke", points: [[1, 2]] },
    })
    expect(encoded).toBeTruthy()
    expect(decodeRoomAppEnvelope(encoded)).toMatchObject({
      lane: "reliable",
      appInstanceId: "shared-canvas:abc123",
    })
    expect(
      encodeRoomAppEnvelope({
        appInstanceId: "shared-canvas:abc123",
        lane: "reliable",
        payload: { text: "界".repeat(ROOM_APP_MAX_PAYLOAD_BYTES) },
      })
    ).toBeNull()
    expect(
      encodeRoomAppEnvelope({
        appInstanceId: "shared-canvas:abc123",
        lane: "reliable",
        payload: { sourceParticipantId: "spoofed" },
      })
    ).toBeNull()
    expect(decodeRoomAppEnvelope(JSON.stringify({ type: "bogus" }))).toBeNull()
  })

  it("requires the exact current instance and handshake token", () => {
    expect(
      decodeRoomAppClientMessage(
        {
          type: "ready",
          appInstanceId: "shared-canvas:abc123",
          handshakeToken: "nonce",
        },
        "shared-canvas:abc123"
      )
    ).toMatchObject({ type: "ready", handshakeToken: "nonce" })
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliable",
          appInstanceId: "other:abc123",
          payload: { type: "stroke" },
        },
        "shared-canvas:abc123"
      )
    ).toBeNull()
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliableTo",
          appInstanceId: "shared-canvas:abc123",
          requestId: "guess-1",
          targetParticipantId: "human-b",
          payload: { type: "private" },
        },
        "shared-canvas:abc123"
      )
    ).toEqual({
      type: "sendReliableTo",
      appInstanceId: "shared-canvas:abc123",
      requestId: "guess-1",
      targetParticipantId: "human-b",
      payload: { type: "private" },
    })
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliableTo",
          appInstanceId: "shared-canvas:abc123",
          requestId: "guess-1",
          targetParticipantId: "bad target",
          payload: { type: "private" },
        },
        "shared-canvas:abc123"
      )
    ).toBeNull()
    expect(
      decodeRoomAppClientMessage(
        {
          type: "sendReliableTo",
          appInstanceId: "shared-canvas:abc123",
          requestId: "contains spaces",
          targetParticipantId: "human-b",
          payload: { type: "private" },
        },
        "shared-canvas:abc123"
      )
    ).toBeNull()
  })

  it("bounds reliable unicast requests and accepts only current-room deliveries/results", () => {
    const appInstanceId = roomAppInstanceId("room-a", "whiteboard")
    const encoded = encodeRoomAppUnicastRequest({
      requestId: "request_1",
      targetParticipantId: "human-b",
      appInstanceId,
      payload: { type: "secret", word: "otter" },
    })
    expect(JSON.parse(encoded!)).toMatchObject({
      type: "room-app-unicast",
      requestId: "request_1",
      targetParticipantId: "human-b",
      appInstanceId,
      payload: { word: "otter" },
    })
    expect(
      encodeRoomAppUnicastRequest({
        requestId: "request_1",
        targetParticipantId: "human-b",
        appInstanceId,
        payload: { word: "界".repeat(ROOM_APP_MAX_PAYLOAD_BYTES) },
      })
    ).toBeNull()

    const delivery = {
      type: "room-app-unicast",
      protocolVersion: 1,
      appInstanceId,
      sourceParticipantId: "human-a",
      payload: { word: "otter" },
    }
    expect(decodeRoomAppUnicastEnvelope(delivery, "room-a")).toMatchObject({
      sourceParticipantId: "human-a",
      payload: { word: "otter" },
    })
    expect(decodeRoomAppUnicastEnvelope(delivery, "room-b")).toBeNull()
    expect(
      decodeRoomAppUnicastResult(
        {
          type: "room-app-unicast-result",
          requestId: "request_1",
          appInstanceId,
          ok: false,
          error: "target_unavailable",
        },
        "room-a"
      )
    ).toMatchObject({ ok: false, error: "target_unavailable" })
  })

  it("accepts only curated instances for the current Room", () => {
    expect(isRoomAppInstanceForRoom("room-a", "whiteboard:00000000")).toBe(
      false
    )
    expect(
      isRoomAppInstanceForRoom(
        "room-a",
        roomAppInstanceId("room-a", "whiteboard")
      )
    ).toBe(true)
  })

  it("bounds the participant projection and separates reliable/realtime rate", () => {
    expect(
      projectRoomAppParticipants([
        { participantId: "a", name: "Alice", kind: "human" },
        { participantId: "b", name: "Pi", kind: "agent" },
      ])
    ).toEqual([
      { participantId: "a", name: "Alice", kind: "human" },
      { participantId: "b", name: "Pi", kind: "agent" },
    ])
    const guard = roomAppRateGuard()
    for (let index = 0; index < 20; index += 1)
      expect(guard.allow("reliable", 1, 1000)).toBe(true)
    expect(guard.allow("reliable", 1, 1000)).toBe(false)
    expect(guard.allow("realtime", 1, 1000)).toBe(true)
    expect(guard.allow("reliable", 1, 2001)).toBe(true)
  })

  it("prunes stale bytes from both lanes before applying the shared budget", () => {
    const guard = roomAppRateGuard()
    expect(guard.allow("realtime", 200_000, 1000)).toBe(true)
    expect(guard.allow("reliable", 100_000, 2001)).toBe(true)
  })

  it("bounds unicast message count and bytes per sender window", () => {
    const guard = roomAppUnicastRateGuard()
    for (let index = 0; index < 10; index += 1)
      expect(guard.allow(1, 1000)).toBe(true)
    expect(guard.allow(1, 1000)).toBe(false)
    expect(guard.allow(1, 2001)).toBe(true)
    const bytesGuard = roomAppUnicastRateGuard()
    expect(bytesGuard.allow(64 * 1024, 1000)).toBe(true)
    expect(bytesGuard.allow(1, 1000)).toBe(false)
  })
})
