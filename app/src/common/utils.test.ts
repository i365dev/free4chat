import { describe, expect, it, vi } from "vitest"

import { trackAnalyticsEvent } from "./utils"

describe("trackAnalyticsEvent", () => {
  it("ignores a delayed Zaraz retry after the browser window is gone", () => {
    vi.useFakeTimers()
    try {
      trackAnalyticsEvent("test-event")
      vi.stubGlobal("window", undefined)

      expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
