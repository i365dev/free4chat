import { describe, expect, it } from "vitest"

import { imageToolResult } from "./toolResults"

// Contract for the #111 read_surface wire shape (#111 review blocker 1):
// the trailing text envelope must wrap metadata under `surface` so Runtime
// clients can parse result.surface uniformly.
describe("imageToolResult", () => {
  it("wraps read_surface metadata under surface and keeps ImageContent first", () => {
    const surface = {
      kind: "workspace-snapshot",
      snapshotId: "123e4567-e89b-42d3-a456-426614174000",
      mimeType: "image/png",
      size: 2048,
      updatedAt: 42,
    }
    const result = imageToolResult({ data: "QUJD", mimeType: "image/png" }, { surface })
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({
      type: "image",
      data: "QUJD",
      mimeType: "image/png",
    })
    expect(result.content[1].type).toBe("text")
    expect(JSON.parse((result.content[1] as { text: string }).text)).toEqual({
      surface,
    })
  })

  it("serializes whatever wrapper is provided (attachment callers keep flat metadata)", () => {
    const result = imageToolResult(
      { data: "QQ", mimeType: "image/jpeg" },
      { id: "att-1", fileName: "a.jpg" }
    )
    expect(JSON.parse((result.content[1] as { text: string }).text)).toEqual({
      id: "att-1",
      fileName: "a.jpg",
    })
  })
})
