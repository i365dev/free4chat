import { describe, expect, it } from "vitest"

import {
  isBoundedRuntimeCapabilityArgs,
  isBoundedRuntimeCapabilityResult,
  validateRuntimeCapabilityProjection,
} from "./runtimeCapability"

const capability = {
  capabilityId: "local-fixture",
  title: "Local fixture",
  version: "1",
  observe: true,
  actions: [
    {
      name: "set-state",
      title: "Set state",
      input: {
        type: "object",
        properties: { value: "string" },
        required: ["value"],
      },
    },
  ],
}

describe("Runtime capability wire projection", () => {
  it("projects only semantic capability fields and bounded closed schemas", () => {
    const projected = validateRuntimeCapabilityProjection({
      ...capability,
      endpoint: "http://127.0.0.1:8080",
      credential: "secret",
    })
    expect(projected).toEqual(capability)
    expect(JSON.stringify(projected)).not.toMatch(
      /endpoint|credential|127\.0\.0\.1/
    )
  })

  it("rejects unbounded, duplicate, or unsupported action schemas", () => {
    expect(
      validateRuntimeCapabilityProjection({
        ...capability,
        actions: [capability.actions[0], capability.actions[0]],
      })
    ).toBeNull()
    expect(
      validateRuntimeCapabilityProjection({
        ...capability,
        actions: [
          {
            ...capability.actions[0],
            input: { type: "object", properties: { value: "object" } },
          },
        ],
      })
    ).toBeNull()
  })

  it("bounds request arguments and result payloads", () => {
    expect(isBoundedRuntimeCapabilityArgs({ value: "ready" })).toBe(true)
    expect(isBoundedRuntimeCapabilityResult({ value: "ready" })).toBe(true)
    expect(isBoundedRuntimeCapabilityResult({ endpoint: "local" })).toBe(false)
    expect(
      isBoundedRuntimeCapabilityResult({ nested: { credential: "secret" } })
    ).toBe(false)
    expect(isBoundedRuntimeCapabilityArgs({ url: "https://localhost" })).toBe(
      false
    )
    expect(isBoundedRuntimeCapabilityArgs({ value: "x".repeat(9000) })).toBe(
      false
    )
    expect(isBoundedRuntimeCapabilityResult({ value: "x".repeat(17000) })).toBe(
      false
    )
  })
})
