import { describe, expect, it, vi } from "vitest"

import { resolveSfuAppSecret } from "./sfuAppSecret"

describe("resolveSfuAppSecret", () => {
  it("keeps the ordinary Worker secret as the preferred source", async () => {
    const get = vi.fn(async () => "store-test-secret")

    await expect(
      resolveSfuAppSecret({
        SFU_APP_SECRET: "worker-test-secret",
        SFU_APP_SECRET_STORE: { get },
      })
    ).resolves.toBe("worker-test-secret")
    expect(get).not.toHaveBeenCalled()
  })

  it("falls back to the Secrets Store binding", async () => {
    const get = vi.fn(async () => "store-test-secret")

    await expect(
      resolveSfuAppSecret({ SFU_APP_SECRET_STORE: { get } })
    ).resolves.toBe("store-test-secret")
    expect(get).toHaveBeenCalledOnce()
  })

  it("returns undefined when both secret sources are absent", async () => {
    await expect(resolveSfuAppSecret({})).resolves.toBeUndefined()
  })

  it("fails closed without exposing a Secrets Store error", async () => {
    const get = vi.fn(async () => {
      throw new Error("store-test-secret-provider-detail")
    })

    await expect(
      resolveSfuAppSecret({ SFU_APP_SECRET_STORE: { get } })
    ).resolves.toBeUndefined()
  })
})
