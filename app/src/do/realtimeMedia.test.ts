import { afterEach, describe, expect, it, vi } from "vitest"

import {
  applyCleanupResults,
  closeRealtimeTracks,
  queuePendingCleanup,
} from "./realtimeMedia"

const env = { SFU_APP_ID: "app-id", SFU_APP_SECRET: "secret" }

describe("closeRealtimeTracks — fail-closed contract (Blocker 1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("a 2xx response is confirmed success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(true)
  })

  it("a 401 response is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("a 429 response is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("a 500 response is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("a network failure (fetch throws) is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("missing SFU credentials with real mids to close is not treated as success", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(closeRealtimeTracks({}, "sess-1", ["1"])).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("an empty mids array is trivially successful (nothing to close) even without credentials", async () => {
    await expect(closeRealtimeTracks({}, "sess-1", [])).resolves.toBe(true)
  })
})

describe("queuePendingCleanup — bounded, merging pending-cleanup queue", () => {
  it("adds a new entry for a fresh sessionId", () => {
    const result = queuePendingCleanup([], "sess-1", ["1", "2"])
    expect(result).toEqual([{ sessionId: "sess-1", mids: ["1", "2"] }])
  })

  it("merges and dedupes mids for an existing sessionId instead of duplicating the entry", () => {
    const existing = [{ sessionId: "sess-1", mids: ["1"] }]
    const result = queuePendingCleanup(existing, "sess-1", ["1", "2"])
    expect(result).toEqual([{ sessionId: "sess-1", mids: ["1", "2"] }])
  })

  it("does not mutate the existing entries it did not touch", () => {
    const existing = [{ sessionId: "sess-1", mids: ["1"] }]
    const result = queuePendingCleanup(existing, "sess-2", ["9"])
    expect(result).toEqual([
      { sessionId: "sess-1", mids: ["1"] },
      { sessionId: "sess-2", mids: ["9"] },
    ])
  })

  it("a no-op call (empty mids) returns the same entries", () => {
    const existing = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(queuePendingCleanup(existing, "sess-1", [])).toEqual(existing)
  })

  it("bounds the total number of entries", () => {
    let entries: ReturnType<typeof queuePendingCleanup> = []
    for (let index = 0; index < 20; index += 1) {
      entries = queuePendingCleanup(entries, `sess-${index}`, [`${index}`])
    }
    expect(entries.length).toBeLessThanOrEqual(16)
    // Most recent entries are kept — the oldest are dropped first.
    expect(entries.at(-1)?.sessionId).toBe("sess-19")
  })

  it("bounds the number of mids retained per entry", () => {
    let entries: ReturnType<typeof queuePendingCleanup> = []
    for (let index = 0; index < 100; index += 1) {
      entries = queuePendingCleanup(entries, "sess-1", [`mid-${index}`])
    }
    expect(entries[0].mids.length).toBeLessThanOrEqual(64)
    expect(entries[0].mids.at(-1)).toBe("mid-99")
  })
})

describe("applyCleanupResults — retry bookkeeping (Blocker 1)", () => {
  it("tracks/close 2xx (success) removes the entry — mids cleared", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(applyCleanupResults(entries, () => true)).toEqual([])
  })

  it("tracks/close 500 (failure) retains the entry — mids retained", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(applyCleanupResults(entries, () => false)).toEqual(entries)
  })

  it("a mixed result only drops the entries that actually succeeded", () => {
    const entries = [
      { sessionId: "sess-1", mids: ["1"] },
      { sessionId: "sess-2", mids: ["2"] },
    ]
    const result = applyCleanupResults(
      entries,
      (entry) => entry.sessionId === "sess-1"
    )
    expect(result).toEqual([{ sessionId: "sess-2", mids: ["2"] }])
  })

  it("retry-then-success eventually clears an entry that first failed", () => {
    let entries = [{ sessionId: "sess-1", mids: ["1"] }]
    entries = applyCleanupResults(entries, () => false) // first attempt fails
    expect(entries).toHaveLength(1)
    entries = applyCleanupResults(entries, () => true) // retry succeeds
    expect(entries).toHaveLength(0)
  })
})
