import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearRoomAppAcquisition,
  isValidAcquisitionPage,
  readRoomAppAcquisition,
  saveRoomAppAcquisition,
  withAcquisitionPage,
} from "./roomAppAcquisition"

const STORAGE_KEY = "free4chat:room-app-acquisition"

describe("#134 Room App acquisition context", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    window.sessionStorage.clear()
  })

  describe("isValidAcquisitionPage", () => {
    it("accepts exactly the Lab's bounded discovery-slug contract", () => {
      for (const value of ["a", "live-poll", "typing-race", "a".repeat(32)]) {
        expect(isValidAcquisitionPage(value)).toBe(true)
      }
    })

    it.each([
      ["an empty value", ""],
      ["a leading hyphen", "-live-poll"],
      ["an uppercase slug", "Live-Poll"],
      ["an over-long slug", "a".repeat(33)],
      ["a path", "apps/live-poll"],
      ["a URL", "https://www.free4.chat/apps/live-poll"],
      ["a query string", "live-poll?ref=x"],
      ["whitespace", " live-poll"],
      ["an array from a repeated query param", ["live-poll", "typing-race"]],
      ["a number", 7],
      ["null", null],
      ["undefined", undefined],
    ])("rejects %s", (_label, value) => {
      expect(isValidAcquisitionPage(value)).toBe(false)
    })
  })

  describe("handoff", () => {
    it("stores one bounded launch context and reads it back for that Room", () => {
      const saved = saveRoomAppAcquisition({
        roomName: "room-a",
        appId: "whiteboard",
        acquisitionPage: "typing-race",
      })

      expect(saved).toEqual({
        roomName: "room-a",
        appId: "whiteboard",
        acquisitionPage: "typing-race",
      })
      expect(readRoomAppAcquisition("room-a")).toEqual(saved)
      // No bounded field is added beyond the launch identity and the intent.
      expect(
        Object.keys(
          JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}")
        )
      ).toEqual(["roomName", "appId", "acquisitionPage"])
    })

    it("never binds a context that is not a valid bounded slug", () => {
      expect(
        saveRoomAppAcquisition({
          roomName: "room-a",
          appId: "whiteboard",
          acquisitionPage: "https://evil.example",
        })
      ).toBeNull()
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it("ignores a mismatched, malformed, or absent entry instead of repairing it", () => {
      saveRoomAppAcquisition({
        roomName: "room-a",
        appId: "whiteboard",
        acquisitionPage: "typing-race",
      })

      // Another Room — an invite link or an unrelated later launch — matches
      // nothing and inherits nothing.
      expect(readRoomAppAcquisition("room-b")).toBeNull()
      expect(readRoomAppAcquisition("")).toBeNull()
      expect(readRoomAppAcquisition("room-a", "draw-and-guess")).toBeNull()

      window.sessionStorage.setItem(STORAGE_KEY, "{not json")
      expect(readRoomAppAcquisition("room-a")).toBeNull()
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ roomName: "room-a" })
      )
      expect(readRoomAppAcquisition("room-a")).toBeNull()
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          roomName: "room-a",
          appId: "whiteboard",
          acquisitionPage: "Not Valid",
        })
      )
      expect(readRoomAppAcquisition("room-a")).toBeNull()
      window.sessionStorage.removeItem(STORAGE_KEY)
      expect(readRoomAppAcquisition("room-a")).toBeNull()
    })

    it("replaces the previous pending context so one tab has at most one", () => {
      saveRoomAppAcquisition({
        roomName: "room-a",
        appId: "whiteboard",
        acquisitionPage: "typing-race",
      })
      saveRoomAppAcquisition({
        roomName: "room-b",
        appId: "bingo",
        acquisitionPage: "live-poll",
      })

      expect(readRoomAppAcquisition("room-a")).toBeNull()
      expect(readRoomAppAcquisition("room-b")?.acquisitionPage).toBe(
        "live-poll"
      )
    })

    it("clears the pending context", () => {
      saveRoomAppAcquisition({
        roomName: "room-a",
        appId: "whiteboard",
        acquisitionPage: "typing-race",
      })
      clearRoomAppAcquisition()

      expect(readRoomAppAcquisition("room-a")).toBeNull()
    })
  })

  describe("withAcquisitionPage", () => {
    it("omits the property entirely when there is no valid context", () => {
      expect(withAcquisitionPage({ app: "whiteboard" }, null)).toEqual({
        app: "whiteboard",
      })
      expect(
        Object.keys(withAcquisitionPage({ app: "whiteboard" }, undefined))
      ).toEqual(["app"])
      expect(
        Object.keys(withAcquisitionPage({ app: "whiteboard" }, "Not Valid"))
      ).toEqual(["app"])
    })

    it("adds one bounded acquisitionPage beside the existing properties", () => {
      expect(
        withAcquisitionPage(
          { app: "whiteboard", participantsBucket: "2-3" },
          "typing-race"
        )
      ).toEqual({
        app: "whiteboard",
        participantsBucket: "2-3",
        acquisitionPage: "typing-race",
      })
    })
  })
})
