import { describe, expect, it } from "vitest"

import {
  deleteSurfaceChunksBestEffort,
  swapSurfaceAfterPersist,
  evaluateSurfacePublish,
  MAX_SURFACE_BYTES,
  sanitizeStoredSurface,
  SURFACE_CHUNK_SIZE,
  surfaceChunkKey,
} from "./surface"

function base(overrides: Record<string, unknown> = {}) {
  return {
    mimeType: "image/png",
    declaredSize: 0,
    byteLength: 1024,
    otherActiveSurfaces: 0,
    publisherHasSurface: false,
    now: 10_000,
    ...overrides,
  }
}

describe("evaluateSurfacePublish", () => {
  it("accepts a supported image and derives the chunk count", () => {
    const result = evaluateSurfacePublish(
      base({ byteLength: SURFACE_CHUNK_SIZE * 5 + 1 }),
    )
    expect(result).toEqual({ ok: true, chunkCount: 6 })
  })

  it("rejects unsupported MIME types", () => {
    for (const bad of ["text/plain", "application/json", "image/gif", 42])
      expect(evaluateSurfacePublish(base({ mimeType: bad })).ok).toBe(false)
    expect(
      evaluateSurfacePublish(base({ mimeType: "text/plain" })),
    ).toMatchObject({ ok: false, error: "surface_mime_unsupported" })
  })

  it("rejects empty and oversized payloads before touching storage", () => {
    expect(evaluateSurfacePublish(base({ byteLength: 0 }))).toMatchObject({
      ok: false,
      error: "surface_empty",
    })
    expect(
      evaluateSurfacePublish(base({ byteLength: MAX_SURFACE_BYTES + 1 })),
    ).toMatchObject({ ok: false, error: "surface_too_large" })
    expect(
      evaluateSurfacePublish(
        base({ declaredSize: 100, byteLength: MAX_SURFACE_BYTES }),
      ),
    ).toMatchObject({ ok: false, error: "surface_size_mismatch" })
  })

  it("throttles rapid replacement but never blocks first publishes", () => {
    expect(
      evaluateSurfacePublish(
        base({
          publisherHasSurface: true,
          publisherLastUpdatedAt: 9_000,
        }),
      ),
    ).toMatchObject({ ok: false, error: "surface_rate_limited" })
    // Exactly at the boundary is allowed.
    expect(
      evaluateSurfacePublish(
        base({
          publisherHasSurface: true,
          publisherLastUpdatedAt: 8_000,
        }),
      ).ok,
    ).toBe(true)
    expect(
      evaluateSurfacePublish(
        base({ otherActiveSurfaces: 0, publisherLastUpdatedAt: undefined }),
      ).ok,
    ).toBe(true)
  })

  it("caps distinct publishers at three while letting existing publishers replace at capacity", () => {
    for (const active of [0, 1, 2])
      expect(
        evaluateSurfacePublish(base({ otherActiveSurfaces: active })).ok,
      ).toBe(true)
    const blocked = evaluateSurfacePublish(base({ otherActiveSurfaces: 3 }))
    expect(blocked).toEqual({
      ok: false,
      error: "surface_capacity_exceeded",
    })
    expect(
      evaluateSurfacePublish(
        base({ otherActiveSurfaces: 3, publisherHasSurface: true }),
      ).ok,
    ).toBe(true)
  })
})

describe("sanitizeStoredSurface", () => {
  const valid = {
    kind: "workspace-snapshot" as const,
    snapshotId: "snap-1",
    mimeType: "image/png" as const,
    size: 2048,
    updatedAt: 123,
  }

  it("keeps valid records untouched by reference", () => {
    const result = sanitizeStoredSurface(valid)
    expect(result.changed).toBe(false)
    expect(result.surface).toBe(valid)
  })

  it("drops invalid records and reports repair", () => {
    for (const broken of [
      null,
      {},
      { ...valid, kind: "other" },
      { ...valid, snapshotId: "" },
      { ...valid, mimeType: "image/gif" },
      { ...valid, size: MAX_SURFACE_BYTES + 1 },
      { ...valid, updatedAt: -1 },
    ]) {
      const result = sanitizeStoredSurface(broken)
      expect(result.surface).toBeUndefined()
      expect(result.changed).toBe(true)
    }
  })

  it("treats absent as unchanged", () => {
    expect(sanitizeStoredSurface(undefined)).toEqual({
      surface: undefined,
      changed: false,
    })
  })
})

describe("surfaceChunkKey", () => {
  it("namespaces chunks under the sweepable surface: prefix", () => {
    expect(surfaceChunkKey("p1", "s1", 3)).toBe("surface:p1:s1:3")
  })
})

describe("deleteSurfaceChunksBestEffort (#111 review)", () => {
  it("resolves even when the underlying deletion throws", async () => {
    await expect(
      deleteSurfaceChunksBestEffort(async () => {
        throw new Error("storage hiccup")
      }),
    ).resolves.toBeUndefined()
  })

  it("awaits successful deletions", async () => {
    let ran = false
    await deleteSurfaceChunksBestEffort(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})

describe("swapSurfaceAfterPersist (#111 review call-site seam)", () => {
  const surfaceA = {
    kind: "workspace-snapshot" as const,
    snapshotId: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
    mimeType: "image/png" as const,
    size: 1024,
    updatedAt: 1,
  }
  const surfaceB = {
    kind: "workspace-snapshot" as const,
    snapshotId: "bbbbbbbb-cccc-4ddd-aeee-ffffffffffff",
    mimeType: "image/jpeg" as const,
    size: 2048,
    updatedAt: 2,
  }

  it("assigns B onto the participant BEFORE persist; delete throw cannot fail publish or revert state", async () => {
    const participant: { surface?: typeof surfaceA } = { surface: surfaceA }
    let persistRan = false
    let deleteAttempts = 0
    const current = await swapSurfaceAfterPersist({
      participant,
      previous: surfaceA,
      updated: surfaceB,
      persistAndBroadcast: async () => {
        persistRan = true
        // Guarding the actual call-site mutation: by the time the RoomRecord
        // is saved/broadcast, the participant must already describe B.
        expect(participant.surface).toEqual(surfaceB)
      },
      deleteOldChunks: async () => {
        deleteAttempts += 1
        throw new Error("storage hiccup deleting A")
      },
    })
    expect(persistRan).toBe(true)
    expect(deleteAttempts).toBe(1)
    expect(current).toEqual(surfaceB)
    expect(participant.surface).toEqual(surfaceB)
  })

  it("deletes nothing when there is no previous snapshot", async () => {
    const participant: { surface?: typeof surfaceA } = {}
    let deleteAttempts = 0
    const current = await swapSurfaceAfterPersist({
      participant,
      updated: surfaceB,
      persistAndBroadcast: async () => {
        expect(participant.surface).toEqual(surfaceB)
      },
      deleteOldChunks: async () => {
        deleteAttempts += 1
      },
    })
    expect(current).toEqual(surfaceB)
    expect(participant.surface).toEqual(surfaceB)
    expect(deleteAttempts).toBe(0)
  })
})
