import { describe, expect, it } from "vitest"

import {
  ROOM_APP_CATALOG,
  ROOM_APP_MAX_PAYLOAD_BYTES,
  decodeRoomAppClientMessage,
  decodeRoomAppEnvelope,
  encodeRoomAppEnvelope,
  isRoomAppInstanceForRoom,
  isRoomAppAllowlisted,
  projectRoomAppParticipants,
  roomAppRateGuard,
  roomAppInstanceId,
  validateRoomAppDefinition,
} from "./roomApp"

describe("Room App Phase 0 bridge contract", () => {
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
  })

  it("accepts only curated instances for the current Room", () => {
    expect(isRoomAppInstanceForRoom("room-a", "shared-canvas:00000000")).toBe(
      false
    )
    expect(
      isRoomAppInstanceForRoom(
        "room-a",
        roomAppInstanceId("room-a", "shared-canvas")
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
})
