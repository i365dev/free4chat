import { describe, expect, it, vi } from "vitest"

import {
  normalizeNavigationType,
  normalizeTurnstileErrorCode,
  normalizeVisibilityState,
  ROOM_LIFECYCLE_DIAGNOSTIC_MAX_EVENTS,
  RoomLifecycleDiagnosticTrace,
} from "./roomLifecycleDiagnostics"

describe("RoomLifecycleDiagnosticTrace", () => {
  it("keeps a bounded trace of explicit events", () => {
    const trace = new RoomLifecycleDiagnosticTrace({ window: null })

    for (
      let index = 0;
      index < ROOM_LIFECYCLE_DIAGNOSTIC_MAX_EVENTS + 5;
      index++
    )
      trace.recordTurnstileStage("turnstile_execute")

    const lines = trace
      .copyText()
      .split("\n")
      .filter((line) => /^\d+ \+\d+ms /.test(line))
    expect(lines).toHaveLength(ROOM_LIFECYCLE_DIAGNOSTIC_MAX_EVENTS)
    expect(lines.every((line) => line.includes(" turnstile_execute"))).toBe(
      true
    )
  })

  it("does not accept arbitrary stage names and copies only bounded schema fields", () => {
    const trace = new RoomLifecycleDiagnosticTrace({ window: null })
    trace.recordTurnstileStage("not-a-stage" as never)
    trace.recordTurnstileError({
      roomName: "private-room",
      token: "private-token",
    })
    trace.markVerificationFailed()

    const copied = trace.copyText()
    expect(copied).toContain("turnstile_error family=unknown code=unknown")
    expect(copied).not.toContain("private-room")
    expect(copied).not.toContain("private-token")
    expect(copied).not.toContain("not-a-stage")
  })

  it("normalizes navigation and visibility to fixed enums", () => {
    expect(normalizeNavigationType("reload")).toBe("reload")
    expect(normalizeNavigationType("anything else")).toBe("unavailable")
    expect(normalizeVisibilityState("visible")).toBe("visible")
    expect(normalizeVisibilityState("anything else")).toBe("other")
  })

  it.each([true, false])(
    "records pageshow and pagehide persisted=%s",
    (persisted) => {
      const pageWindow = window
      const trace = new RoomLifecycleDiagnosticTrace({
        window: pageWindow,
        storage: null,
      })

      pageWindow.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted })
      )
      pageWindow.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted })
      )

      expect(trace.copyText()).toMatch(
        new RegExp(
          `pageshow persisted=${persisted} visibility=(visible|hidden|other)`
        )
      )
      expect(trace.copyText()).toMatch(
        new RegExp(
          `pagehide persisted=${persisted} visibility=(visible|hidden|other)`
        )
      )
      trace.dispose()
    }
  )

  it("removes lifecycle listeners when disposed", () => {
    const remove = vi.spyOn(window, "removeEventListener")
    const trace = new RoomLifecycleDiagnosticTrace({ window, storage: null })

    trace.dispose()

    expect(remove).toHaveBeenCalledWith("pageshow", expect.any(Function))
    expect(remove).toHaveBeenCalledWith("pagehide", expect.any(Function))
    remove.mockRestore()
  })

  it("captures normalized navigation and resolves first-pageshow waiters from its lifecycle listener", async () => {
    const navigation = vi
      .spyOn(window.performance, "getEntriesByType")
      .mockReturnValue([
        { type: "back_forward" } as PerformanceNavigationTiming,
      ])
    const add = vi.spyOn(window, "addEventListener")
    const trace = new RoomLifecycleDiagnosticTrace({ window, storage: null })

    expect(trace.navigationType()).toBe("back_forward")
    expect(trace.hasSeenPageShow()).toBe(false)
    const firstWait = trace.waitForFirstPageShow()
    const secondWait = trace.waitForFirstPageShow()
    expect(
      add.mock.calls.filter(([name]) => String(name) === "pageshow")
    ).toHaveLength(1)

    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false })
    )
    await expect(firstWait).resolves.toBe(true)
    await expect(secondWait).resolves.toBe(true)
    expect(trace.hasSeenPageShow()).toBe(true)
    await expect(trace.waitForFirstPageShow()).resolves.toBe(true)

    trace.dispose()
    add.mockRestore()
    navigation.mockRestore()
  })

  it("cancels first-pageshow waiters on abort and teardown", async () => {
    const trace = new RoomLifecycleDiagnosticTrace({ window, storage: null })
    const abortController = new AbortController()
    const abortedWait = trace.waitForFirstPageShow(abortController.signal)
    abortController.abort()
    await expect(abortedWait).resolves.toBe(false)

    const disposedWait = trace.waitForFirstPageShow()
    trace.dispose()
    await expect(disposedWait).resolves.toBe(false)
    expect(trace.hasSeenPageShow()).toBe(false)
  })

  it("normalizes known exact codes and generic retryable families", () => {
    expect(normalizeTurnstileErrorCode(200500)).toEqual({
      family: "200",
      code: "200500",
      inputKind: "number",
    })
    expect(normalizeTurnstileErrorCode("200500")).toEqual({
      family: "200",
      code: "200500",
      inputKind: "numeric_string",
    })
    expect(normalizeTurnstileErrorCode(110600)).toEqual({
      family: "110",
      code: "110600",
      inputKind: "number",
    })
    expect(normalizeTurnstileErrorCode(110620)).toEqual({
      family: "110",
      code: "110620",
      inputKind: "number",
    })
    expect(normalizeTurnstileErrorCode(300123)).toEqual({
      family: "300",
      code: "300xxx",
      inputKind: "number",
    })
    expect(normalizeTurnstileErrorCode("300123")).toEqual({
      family: "300",
      code: "300xxx",
      inputKind: "numeric_string",
    })
    expect(normalizeTurnstileErrorCode(600123)).toEqual({
      family: "600",
      code: "600xxx",
      inputKind: "number",
    })
    expect(normalizeTurnstileErrorCode("600123")).toEqual({
      family: "600",
      code: "600xxx",
      inputKind: "numeric_string",
    })
    expect(normalizeTurnstileErrorCode("200500")).toEqual({
      family: "200",
      code: "200500",
      inputKind: "numeric_string",
    })
    expect(normalizeTurnstileErrorCode(200501)).toEqual({
      family: "unknown",
      code: "unknown",
      inputKind: "number",
    })
    expect(normalizeTurnstileErrorCode(undefined)).toEqual({
      family: "unknown",
      code: "unknown",
      inputKind: "missing",
    })
    expect(normalizeTurnstileErrorCode("challenge failed")).toEqual({
      family: "unknown",
      code: "unknown",
      inputKind: "other",
    })
    expect(normalizeTurnstileErrorCode({ secret: "must-not-escape" })).toEqual({
      family: "unknown",
      code: "unknown",
      inputKind: "other",
    })
  })

  it("persists and reads only one sanitized last failed attempt", () => {
    const storage = window.sessionStorage
    storage.clear()
    const failed = new RoomLifecycleDiagnosticTrace({ window: null, storage })
    failed.recordTurnstileError(200500)
    failed.markVerificationFailed()

    const afterReload = new RoomLifecycleDiagnosticTrace({
      window: null,
      storage,
    })
    expect(afterReload.copyText()).toContain("previous_failed:")
    expect(afterReload.copyText()).toContain(
      "turnstile_error family=200 code=200500"
    )

    afterReload.recordTurnstileError(110620)
    afterReload.markVerificationFailed()
    const newest = new RoomLifecycleDiagnosticTrace({
      window: null,
      storage,
    })
    expect(newest.copyText()).toContain("previous_failed:")
    expect(newest.copyText()).toContain(
      "turnstile_error family=110 code=110620"
    )
    expect(newest.copyText()).not.toContain("200500")
    expect(newest.copyText()).not.toContain("must-not-escape")
  })

  it("keeps verification behavior independent of unavailable sessionStorage", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
      clear: () => {
        throw new Error("blocked")
      },
      key: () => null,
      length: 0,
    } satisfies Storage
    const trace = new RoomLifecycleDiagnosticTrace({ window: null, storage })

    expect(() => {
      trace.recordTurnstileError("bad input")
      trace.markVerificationFailed()
    }).not.toThrow()
    expect(trace.copyText()).toContain("verification_failed")
  })
})
