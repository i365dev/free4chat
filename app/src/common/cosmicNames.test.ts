import { describe, expect, it } from "vitest"

import { generateParticipantName, generateRoomName } from "./cosmicNames"

const roomPattern = /^[a-z]+-[a-z]+-[23456789abcdefghjkmnpqrstuvwxyz]{12}$/

describe("cosmic naming", () => {
  it("generates a readable Room id with injected deterministic entropy", () => {
    const room = generateRoomName(() => 0)

    expect(room).toBe("andromeda-arc-222222222222")
    expect(room).toMatch(roomPattern)
    expect(room.length).toBeLessThanOrEqual(64)
  })

  it("keeps Room ids in the URL-safe, lowercase namespace", () => {
    const entropy = (() => {
      let value = 0
      return () => {
        value = (value + 0.173) % 1
        return value
      }
    })()

    const room = generateRoomName(entropy)
    expect(room).toMatch(roomPattern)
    expect(room).not.toMatch(/[A-Z\s_]/)
  })

  it("generates short planet-style participant names", () => {
    const name = generateParticipantName(() => 0)

    expect(name).toBe("Veyra")
    expect(name).toMatch(/^[A-Z][a-z]+$/)
    expect(name).not.toMatch(/[0-9\s-]/)
    expect(name.length).toBeLessThanOrEqual(32)
  })

  it("keeps participant output deterministic for a supplied entropy source", () => {
    const entropy = () => 0.5
    expect(generateParticipantName(entropy)).toBe(
      generateParticipantName(entropy)
    )
  })
})
