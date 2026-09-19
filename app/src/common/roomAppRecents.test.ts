import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  inlineRoomAppIds,
  pruneRecentRoomAppIds,
  pushRecentRoomAppId,
  readRecentRoomAppIds,
  ROOM_APP_INLINE_RECENT_MAX,
  ROOM_APP_INLINE_RECENT_MAX_DESKTOP,
  ROOM_APP_RECENT_MAX,
  writeRecentRoomAppIds,
} from "./roomAppRecents"

/**
 * #98 regressions for the bounded, Room-scoped recency that backs the inline
 * Stage strip. The product property under test is deliberately small: a tiny
 * recent set, no duplicates, no catalog escape hatch, and no persistence beyond
 * the current browser tab.
 */
describe("Room App recency", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    window.sessionStorage.clear()
  })

  it("keeps both inline bounds tiny and ordered by width", () => {
    expect(ROOM_APP_INLINE_RECENT_MAX).toBeLessThanOrEqual(2)
    expect(ROOM_APP_INLINE_RECENT_MAX_DESKTOP).toBe(
      ROOM_APP_INLINE_RECENT_MAX + 1
    )
  })

  it("moves an opened App to the front", () => {
    const first = pushRecentRoomAppId([], "whiteboard")
    expect(first).toEqual(["whiteboard"])
    expect(pushRecentRoomAppId(first, "live-poll")).toEqual([
      "live-poll",
      "whiteboard",
    ])
  })

  it("never accumulates duplicates when an App is reopened", () => {
    let recents: string[] = []
    for (const id of [
      "whiteboard",
      "live-poll",
      "whiteboard",
      "retro",
      "retro",
    ])
      recents = pushRecentRoomAppId(recents, id)
    expect(recents).toEqual(["retro", "whiteboard", "live-poll"])
    expect(new Set(recents).size).toBe(recents.length)
  })

  it("bounds the remembered list however many Apps are opened", () => {
    let recents: string[] = []
    for (let index = 0; index < 40; index += 1)
      recents = pushRecentRoomAppId(recents, `app-${index}`)
    expect(recents).toHaveLength(ROOM_APP_RECENT_MAX)
    expect(recents[0]).toBe("app-39")
  })

  it("drops Apps the current catalog no longer offers", () => {
    const available = new Set(["whiteboard", "retro"])
    expect(
      pruneRecentRoomAppIds(["live-poll", "retro", "whiteboard"], available)
    ).toEqual(["retro", "whiteboard"])
    expect(pruneRecentRoomAppIds(["gone"], available)).toEqual([])
  })

  it("caps a plain 18-App catalog to a bounded inline set", () => {
    const catalogIds = Array.from({ length: 18 }, (_, index) => `app-${index}`)
    const available = new Set(catalogIds)
    const recents = catalogIds.reduce<string[]>(
      (previous, id) => pushRecentRoomAppId(previous, id),
      []
    )
    const inline = inlineRoomAppIds(recents, "app-17", available)
    expect(inline).toHaveLength(ROOM_APP_INLINE_RECENT_MAX)
    expect(inline[0]).toBe("app-17")
    expect(inline).not.toContain("app-0")
  })

  it("shows the current App even when it was never recorded as recent", () => {
    const available = new Set(["whiteboard", "retro"])
    expect(inlineRoomAppIds(["retro"], "whiteboard", available, 2)).toEqual([
      "whiteboard",
      "retro",
    ])
  })

  it("never lists the current App twice", () => {
    const available = new Set(["whiteboard", "retro"])
    expect(
      inlineRoomAppIds(["whiteboard", "retro"], "whiteboard", available)
    ).toEqual(["whiteboard", "retro"])
  })

  it("ignores remembered Apps that are no longer in the catalog", () => {
    const available = new Set(["retro"])
    expect(inlineRoomAppIds(["gone", "retro"], null, available)).toEqual([
      "retro",
    ])
  })

  it("round-trips this Room's order through browser-session storage only", () => {
    writeRecentRoomAppIds("room-a", ["whiteboard", "retro"])
    expect(readRecentRoomAppIds("room-a")).toEqual(["whiteboard", "retro"])
    // Room-scoped: a different Room in the same tab starts clean.
    expect(readRecentRoomAppIds("room-b")).toEqual([])
    // No durable preference of any kind is written.
    expect(window.localStorage.length).toBe(0)
    expect(Object.keys(window.localStorage)).toEqual([])
  })

  it("de-duplicates and bounds anything read back from storage", () => {
    window.sessionStorage.setItem(
      "free4chat:room-app-recents:v1:room-a",
      JSON.stringify([
        "whiteboard",
        "whiteboard",
        "retro",
        ...Array.from({ length: 20 }, (_, index) => `app-${index}`),
      ])
    )
    const recents = readRecentRoomAppIds("room-a")
    expect(recents.slice(0, 2)).toEqual(["whiteboard", "retro"])
    expect(recents).toHaveLength(ROOM_APP_RECENT_MAX)
  })

  it("fails closed to an empty list when storage holds junk", () => {
    window.sessionStorage.setItem(
      "free4chat:room-app-recents:v1:room-a",
      "{not json"
    )
    expect(readRecentRoomAppIds("room-a")).toEqual([])
    window.sessionStorage.setItem(
      "free4chat:room-app-recents:v1:room-a",
      JSON.stringify({ whiteboard: true })
    )
    expect(readRecentRoomAppIds("room-a")).toEqual([])
  })

  it("clears the remembered entry when nothing is recent", () => {
    writeRecentRoomAppIds("room-a", ["whiteboard"])
    writeRecentRoomAppIds("room-a", [])
    expect(readRecentRoomAppIds("room-a")).toEqual([])
    expect(window.sessionStorage.length).toBe(0)
  })
})
