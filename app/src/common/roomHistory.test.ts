import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ROOM_HISTORY_STORAGE_KEY,
  browserRepeatUse,
  priorRoomCount,
  priorRoomCountBucket,
} from "./roomHistory"
import { saveRoomToLocalStorage } from "./utils"

/**
 * #346: same-browser repeat-use direction.
 *
 * The signal must be browser-local, coarse, and directional:
 *   - no durable identifier is introduced for it;
 *   - no historical Room name (or nickname) ever leaves the browser;
 *   - the CURRENT Room is never counted as prior use, whether or not the
 *     join flow has already remembered it.
 */

describe("priorRoomCountBucket (#346)", () => {
  it("uses the documented coarse bands", () => {
    expect(priorRoomCountBucket(0)).toBe("0")
    expect(priorRoomCountBucket(1)).toBe("1")
    expect(priorRoomCountBucket(2)).toBe("2-5")
    expect(priorRoomCountBucket(5)).toBe("2-5")
    expect(priorRoomCountBucket(6)).toBe("6+")
    expect(priorRoomCountBucket(250)).toBe("6+")
  })

  it("treats an impossible count as no prior use rather than a new bucket", () => {
    for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(priorRoomCountBucket(count)).toBe("0")
    }
  })
})

describe("priorRoomCount (#346)", () => {
  it("excludes the current Room from prior use", () => {
    // The join flow writes the current Room BEFORE activation, so the stored
    // list already contains it — counting it would be the off-by-one.
    expect(priorRoomCount(["room-a"], "room-a")).toBe(0)
    expect(priorRoomCount(["room-a", "room-b"], "room-b")).toBe(1)
    expect(priorRoomCount(["room-a"], "room-b")).toBe(1)
    expect(priorRoomCount([], "room-a")).toBe(0)
  })

  it("counts each remembered Room once, even against a repeated name", () => {
    // The existing helper stores at most one entry per Room name, but the
    // exclusion must stay correct even for a malformed list.
    expect(priorRoomCount(["room-a", "room-a"], "room-b")).toBe(2)
    expect(priorRoomCount(["room-a", "room-a"], "room-a")).toBe(0)
  })
})

describe("browserRepeatUse (#346)", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it("reports no prior use for a first-time browser", () => {
    expect(browserRepeatUse("room-new")).toEqual({
      returningBrowser: false,
      priorRoomCountBucket: "0",
    })
  })

  it("reports correct buckets for 1, 2..5, and 6+ prior Rooms", () => {
    const remember = (names: string[]) =>
      window.localStorage.setItem(
        ROOM_HISTORY_STORAGE_KEY,
        JSON.stringify(names.map((roomName) => ({ roomName, nickName: "n" })))
      )

    remember(["room-1"])
    expect(browserRepeatUse("room-new")).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "1",
    })

    remember(["room-1", "room-2", "room-3", "room-4", "room-5"])
    expect(browserRepeatUse("room-new")).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "2-5",
    })

    remember([
      "room-1",
      "room-2",
      "room-3",
      "room-4",
      "room-5",
      "room-6",
      "room-7",
    ])
    expect(browserRepeatUse("room-new")).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "6+",
    })
  })

  it("never counts the current Room as prior use, in either write order", () => {
    // Before the join flow remembered it.
    window.localStorage.setItem(
      ROOM_HISTORY_STORAGE_KEY,
      JSON.stringify([{ roomName: "room-x", nickName: "n" }])
    )
    expect(browserRepeatUse("room-x")).toEqual({
      returningBrowser: false,
      priorRoomCountBucket: "0",
    })

    // After the real join flow wrote it (the production ordering).
    saveRoomToLocalStorage("room-x", "nick")
    expect(browserRepeatUse("room-x")).toEqual({
      returningBrowser: false,
      priorRoomCountBucket: "0",
    })

    // A genuinely prior Room still counts.
    saveRoomToLocalStorage("room-y", "nick")
    expect(browserRepeatUse("room-x")).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "1",
    })
  })

  it("sends no Room name or nickname through the emitted properties", () => {
    saveRoomToLocalStorage("secret-room-alpha", "Alice")
    saveRoomToLocalStorage("secret-room-beta", "Bob")
    const properties = browserRepeatUse("secret-room-current")
    const serialized = JSON.stringify(properties)
    expect(serialized).not.toContain("secret-room")
    expect(serialized).not.toContain("Alice")
    expect(serialized).not.toContain("Bob")
    // Only the two approved coarse properties exist — there is no raw count
    // and no room name key at all.
    expect(Object.keys(properties).sort()).toEqual([
      "priorRoomCountBucket",
      "returningBrowser",
    ])
    expect(properties.priorRoomCountBucket).toBe("2-5")
    expect(Object.values(properties)).not.toContain(2)
  })

  it("degrades to no prior use on unreadable or foreign storage", () => {
    for (const raw of [
      "not json",
      "{}",
      "42",
      "[null]",
      JSON.stringify([{ nickName: "no room name" }]),
      JSON.stringify([{ roomName: 42 }]),
    ]) {
      window.localStorage.setItem(ROOM_HISTORY_STORAGE_KEY, raw)
      expect(browserRepeatUse("room-new")).toEqual({
        returningBrowser: false,
        priorRoomCountBucket: "0",
      })
    }
  })
})
