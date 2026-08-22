import { describe, expect, it } from "vitest"

import {
  computeExpiresAt,
  EMPTY_ROOM_TIMEOUT_MS,
  NO_EXPIRY,
} from "./roomExpiry"

const NOW = Date.UTC(2026, 0, 1)

describe("computeExpiresAt", () => {
  it("never expires a room that has at least one participant", () => {
    expect(computeExpiresAt(1, NO_EXPIRY, NOW)).toBe(NO_EXPIRY)
    expect(computeExpiresAt(3, NO_EXPIRY, NOW)).toBe(NO_EXPIRY)
  })

  it("cancels a pending empty-room deadline once a participant (re)joins", () => {
    const pendingDeadline = NOW + 5 * 60 * 1000
    expect(computeExpiresAt(1, pendingDeadline, NOW)).toBe(NO_EXPIRY)
  })

  it("starts a fresh EMPTY_ROOM_TIMEOUT_MS deadline the moment a room becomes empty", () => {
    expect(computeExpiresAt(0, NO_EXPIRY, NOW)).toBe(
      NOW + EMPTY_ROOM_TIMEOUT_MS
    )
  })

  it("does not push the deadline forward on repeated calls while still empty", () => {
    const firstDeadline = computeExpiresAt(0, NO_EXPIRY, NOW)
    const later = NOW + 10 * 60 * 1000
    const secondDeadline = computeExpiresAt(0, firstDeadline, later)
    expect(secondDeadline).toBe(firstDeadline)
    expect(secondDeadline).not.toBe(later + EMPTY_ROOM_TIMEOUT_MS)
  })

  it("supports the full occupied -> empty -> rejoin -> empty-again lifecycle", () => {
    // Room created with its first participant: never expires.
    let expiresAt = computeExpiresAt(1, NO_EXPIRY, NOW)
    expect(expiresAt).toBe(NO_EXPIRY)

    // Everyone leaves: a real deadline is set once.
    const emptiedAt = NOW + 60_000
    expiresAt = computeExpiresAt(0, expiresAt, emptiedAt)
    expect(expiresAt).toBe(emptiedAt + EMPTY_ROOM_TIMEOUT_MS)

    // Still empty a bit later: deadline is untouched (not pushed out).
    const stillEmptyAt = emptiedAt + 60_000
    expiresAt = computeExpiresAt(0, expiresAt, stillEmptyAt)
    expect(expiresAt).toBe(emptiedAt + EMPTY_ROOM_TIMEOUT_MS)

    // Someone rejoins before the deadline: expiry is cancelled.
    const rejoinedAt = emptiedAt + 120_000
    expiresAt = computeExpiresAt(1, expiresAt, rejoinedAt)
    expect(expiresAt).toBe(NO_EXPIRY)

    // They leave again later: a brand-new deadline starts from *this* empty
    // moment, not the original one.
    const emptiedAgainAt = rejoinedAt + 600_000
    expiresAt = computeExpiresAt(0, expiresAt, emptiedAgainAt)
    expect(expiresAt).toBe(emptiedAgainAt + EMPTY_ROOM_TIMEOUT_MS)
  })
})
