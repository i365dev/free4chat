import { afterEach, describe, expect, it, vi } from "vitest"

import {
  closeRealtimeTracks,
  pendingCleanupHasCapacity,
  queuePendingCleanup,
  removeConfirmedMids,
} from "./realtimeMedia"

const env = { SFU_APP_ID: "app-id", SFU_APP_SECRET: "secret" }

describe("closeRealtimeTracks — fail-closed contract", () => {
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

describe("queuePendingCleanup — purely additive, never evicts to stay bounded", () => {
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

  it("never evicts an unresolved entry past the soft bound — growth is unbounded here by design", () => {
    // The bound is enforced by refusing *new* admission elsewhere
    // (pendingCleanupHasCapacity), never by this function silently dropping
    // already-queued, still-unresolved cleanup work.
    let entries: ReturnType<typeof queuePendingCleanup> = []
    for (let index = 0; index < 20; index += 1) {
      entries = queuePendingCleanup(entries, `sess-${index}`, [`${index}`])
    }
    expect(entries).toHaveLength(20)
    expect(entries[0].sessionId).toBe("sess-0") // the oldest entry is still present
  })

  it("never truncates the mids on a single entry past the soft per-entry bound", () => {
    let entries: ReturnType<typeof queuePendingCleanup> = []
    for (let index = 0; index < 100; index += 1) {
      entries = queuePendingCleanup(entries, "sess-1", [`mid-${index}`])
    }
    expect(entries[0].mids).toHaveLength(100)
    expect(entries[0].mids[0]).toBe("mid-0") // the oldest mid is still present
  })
})

describe("pendingCleanupHasCapacity — the actual bound-enforcement point", () => {
  it("has capacity for a brand-new sessionId under the entry cap", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(pendingCleanupHasCapacity(entries, "sess-2")).toBe(true)
  })

  it("refuses a brand-new sessionId once the entry cap is reached", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      sessionId: `sess-${index}`,
      mids: ["1"],
    }))
    expect(pendingCleanupHasCapacity(entries, "sess-new")).toBe(false)
  })

  it("an existing sessionId is unaffected by the entry cap (it isn't a new entry)", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      sessionId: `sess-${index}`,
      mids: ["1"],
    }))
    expect(pendingCleanupHasCapacity(entries, "sess-0")).toBe(true)
  })

  it("refuses more mids on an existing entry once its per-entry cap is reached", () => {
    const entries = [
      {
        sessionId: "sess-1",
        mids: Array.from({ length: 64 }, (_, i) => `${i}`),
      },
    ]
    expect(pendingCleanupHasCapacity(entries, "sess-1", 1)).toBe(false)
  })

  it("has capacity for more mids on an existing entry under its per-entry cap", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1", "2"] }]
    expect(pendingCleanupHasCapacity(entries, "sess-1", 1)).toBe(true)
  })
})

describe("removeConfirmedMids — the narrow, merge-only-the-result half of the fetch-then-reload pattern", () => {
  it("tracks/close 2xx (success) removes exactly the confirmed mids", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(
      removeConfirmedMids(entries, [{ sessionId: "sess-1", mids: ["1"] }])
    ).toEqual([])
  })

  it("an entry that was never confirmed is left untouched — mids retained", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(removeConfirmedMids(entries, [])).toEqual(entries)
  })

  it("only removes the confirmed subset of an entry's mids, keeping the rest", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1", "2", "3"] }]
    const result = removeConfirmedMids(entries, [
      { sessionId: "sess-1", mids: ["2"] },
    ])
    expect(result).toEqual([{ sessionId: "sess-1", mids: ["1", "3"] }])
  })

  it("a mixed result only drops the entries that actually got confirmed", () => {
    const entries = [
      { sessionId: "sess-1", mids: ["1"] },
      { sessionId: "sess-2", mids: ["2"] },
    ]
    const result = removeConfirmedMids(entries, [
      { sessionId: "sess-1", mids: ["1"] },
    ])
    expect(result).toEqual([{ sessionId: "sess-2", mids: ["2"] }])
  })

  it("retry-then-success eventually clears an entry that first failed", () => {
    let entries = [{ sessionId: "sess-1", mids: ["1"] }]
    entries = removeConfirmedMids(entries, []) // first attempt: nothing confirmed
    expect(entries).toHaveLength(1)
    entries = removeConfirmedMids(entries, [
      { sessionId: "sess-1", mids: ["1"] },
    ]) // retry succeeds
    expect(entries).toHaveLength(0)
  })

  // The core Durable Object interleaving fix (round 4): a close attempt is
  // always based on a *pre-fetch* snapshot of what needed closing. By the
  // time the fetch resolves, a concurrent request may have already
  // persisted *new* pending-cleanup state (e.g. a different agent's
  // revocation). The merge must only ever remove what this specific fetch
  // confirmed — never blindly overwrite with the pre-fetch snapshot, which
  // would silently drop that concurrently-written entry.
  it("interleaving safety: only removes the confirmed pre-fetch entry, preserving anything written while the fetch was in flight", () => {
    const preFetchSnapshot = [{ sessionId: "sess-1", mids: ["mid-a"] }]
    // Simulates: after the fetch for sess-1 was kicked off (based on
    // preFetchSnapshot), a *different*, concurrent request revoked a
    // second agent and persisted its own pending-cleanup entry before this
    // fetch resolved.
    const freshAfterInterleave = [
      { sessionId: "sess-1", mids: ["mid-a"] },
      { sessionId: "sess-2", mids: ["mid-b"] },
    ]
    const merged = removeConfirmedMids(freshAfterInterleave, preFetchSnapshot)
    expect(merged).toEqual([{ sessionId: "sess-2", mids: ["mid-b"] }])
  })

  it("interleaving safety: preserves mids added to the *same* sessionId while the fetch was in flight", () => {
    const preFetchSnapshot = [{ sessionId: "sess-1", mids: ["mid-a"] }]
    // A concurrent request added a second mid to the *same* session before
    // this fetch (which only ever knew about mid-a) resolved.
    const freshAfterInterleave = [
      { sessionId: "sess-1", mids: ["mid-a", "mid-b"] },
    ]
    const merged = removeConfirmedMids(freshAfterInterleave, preFetchSnapshot)
    expect(merged).toEqual([{ sessionId: "sess-1", mids: ["mid-b"] }])
  })
})
