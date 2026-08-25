import { describe, expect, it } from "vitest"

import { buildRoomInvite } from "./invite"

describe("buildRoomInvite", () => {
  it("emits exactly the v1 descriptor shape with an encoded room URL", () => {
    const invite = buildRoomInvite("room/id with spaces&stuff")
    expect(invite).toEqual({
      kind: "free4chat.room-invite",
      version: 1,
      roomId: "room/id with spaces&stuff",
      roomUrl:
        "https://www.free4.chat/room?id=" +
        encodeURIComponent("room/id with spaces&stuff"),
    })
  })

  it("carries only public data — never handles, tokens, or credentials", () => {
    const serialized = JSON.stringify(
      buildRoomInvite("11111111-2222-3333-4444-555555555555")
    )
    expect(serialized).not.toMatch(/participantHandle|participantToken|token/i)
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "kind",
      "version",
      "roomId",
      "roomUrl",
    ])
  })

  it("satisfies MAX_ROOM_LENGTH-style UUID ids without truncation", () => {
    const roomId = "123e4567-e89b-42d3-a456-426614174000"
    const invite = buildRoomInvite(roomId)
    expect(invite.roomId).toBe(roomId)
    expect(invite.roomUrl.endsWith(encodeURIComponent(roomId))).toBe(true)
  })
})
