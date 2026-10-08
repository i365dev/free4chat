import { afterEach, describe, expect, it, vi } from "vitest"

describe("app lifecycle bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("observes pageshow before a late Room lifecycle consumer starts", async () => {
    vi.resetModules()
    vi.spyOn(window.performance, "getEntriesByType").mockReturnValue([
      { type: "back_forward" } as PerformanceNavigationTiming,
    ])
    const addEventListener = vi.spyOn(window, "addEventListener")

    await import("../../pages/_app")

    expect(
      addEventListener.mock.calls.some(
        ([eventName]) => String(eventName) === "pageshow"
      )
    ).toBe(true)
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false })
    )

    // The Room consumer loads from a later dynamic chunk. It must read the
    // already-initialized singleton and proceed without waiting for a second
    // pageshow event.
    const { roomLifecycleDiagnostics } = await import(
      "../../common/roomLifecycleDiagnostics"
    )
    expect(roomLifecycleDiagnostics.navigationType()).toBe("back_forward")
    expect(roomLifecycleDiagnostics.hasSeenPageShow()).toBe(true)
    await expect(roomLifecycleDiagnostics.waitForFirstPageShow()).resolves.toBe(
      true
    )

    roomLifecycleDiagnostics.dispose()
  })
})
