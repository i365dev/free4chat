import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ROOM_HISTORY_STORAGE_KEY,
  priorRoomCountBucket,
  type BrowserRepeatUse,
} from "./roomHistory"

/**
 * #346: same-browser repeat-use direction.
 *
 * The signal must be browser-local, coarse, and directional:
 *   - no durable identifier is introduced for it;
 *   - no historical Room name (or nickname) ever leaves the browser;
 *   - the CURRENT page load's own history write is never counted as prior
 *     use, while a Room this browser genuinely remembered before this launch
 *     IS — including when it is the same Room NAME (a name reused after
 *     expiry is a new Room generation, but it is still returning use).
 *
 * `roomHistory` freezes its pre-visit snapshot on first touch, so every test
 * re-imports the module to get a fresh page-load boundary. The writer helper
 * is exercised through the real `saveRoomToLocalStorage`.
 */

async function freshModule() {
  vi.resetModules()
  const roomHistory = await import("./roomHistory")
  const utils = await import("./utils")
  return {
    ...roomHistory,
    saveRoomToLocalStorage: utils.saveRoomToLocalStorage,
  }
}

function remember(names: string[]) {
  window.localStorage.setItem(
    ROOM_HISTORY_STORAGE_KEY,
    JSON.stringify(names.map((roomName) => ({ roomName, nickName: "n" })))
  )
}

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

describe("browserRepeatUse (#346)", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  async function repeatUse(): Promise<BrowserRepeatUse> {
    const mod = await freshModule()
    return mod.browserRepeatUse()
  }

  it("reports no prior use for a browser that remembered nothing", async () => {
    expect(await repeatUse()).toEqual({
      returningBrowser: false,
      priorRoomCountBucket: "0",
    })
  })

  it("does not count THIS launch's own history write as prior use", async () => {
    const mod = await freshModule()
    mod.saveRoomToLocalStorage("room-first", "Alice")
    expect(mod.browserRepeatUse()).toEqual({
      returningBrowser: false,
      priorRoomCountBucket: "0",
    })
  })

  it("counts a returning browser that reuses the SAME Room name", async () => {
    // The reported gap: the history is deduplicated by name, so excluding the
    // current name would score this as a brand-new browser. The Room name is
    // the same; the canonical generation behind it is not, and neither fact
    // makes the human a first-time user.
    remember(["room-a"])
    const mod = await freshModule()
    // The join flow rewrites the entry for this launch's visit.
    mod.saveRoomToLocalStorage("room-a", "Alice")
    expect(window.localStorage.getItem(ROOM_HISTORY_STORAGE_KEY)).toContain(
      "room-a"
    )
    expect(mod.browserRepeatUse()).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "1",
    })
  })

  it("counts a returning browser that opens the same Room without a rewrite", async () => {
    // The same Room page can bind straight from remembered history and never
    // write at all.
    remember(["room-a"])
    expect(await repeatUse()).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "1",
    })
  })

  it("reports correct buckets for 1, 2..5, and 6+ prior Rooms", async () => {
    remember(["room-1"])
    expect((await repeatUse()).priorRoomCountBucket).toBe("1")

    remember(["room-1", "room-2", "room-3", "room-4", "room-5"])
    expect(await repeatUse()).toEqual({
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
    expect((await repeatUse()).priorRoomCountBucket).toBe("6+")
  })

  it("counts distinct remembered Rooms only", async () => {
    // The writer deduplicates by name; a duplicated or malformed list must
    // still not inflate the signal.
    window.localStorage.setItem(
      ROOM_HISTORY_STORAGE_KEY,
      JSON.stringify([
        { roomName: "room-a", nickName: "n" },
        { roomName: "room-a", nickName: "n" },
        { nickName: "no room name" },
        { roomName: 42 },
      ])
    )
    expect(await repeatUse()).toEqual({
      returningBrowser: true,
      priorRoomCountBucket: "1",
    })
  })

  it("sends no Room name or nickname through the emitted properties", async () => {
    remember(["secret-room-alpha", "secret-room-beta"])
    const properties = await repeatUse()
    const serialized = JSON.stringify(properties)
    expect(serialized).not.toContain("secret-room")
    expect(serialized).not.toContain("Alice")
    expect(Object.keys(properties).sort()).toEqual([
      "priorRoomCountBucket",
      "returningBrowser",
    ])
    expect(properties.priorRoomCountBucket).toBe("2-5")
    expect(Object.values(properties)).not.toContain(2)
  })

  it("degrades to no prior use on unreadable or foreign storage", async () => {
    for (const raw of ["not json", "{}", "42", "[null]"]) {
      window.localStorage.setItem(ROOM_HISTORY_STORAGE_KEY, raw)
      expect(await repeatUse()).toEqual({
        returningBrowser: false,
        priorRoomCountBucket: "0",
      })
    }
  })
})
