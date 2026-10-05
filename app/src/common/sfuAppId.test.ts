import { describe, expect, it, vi } from "vitest"

import { resolveSfuAppId } from "./sfuAppId"

describe("resolveSfuAppId", () => {
  it("prefers the ordinary Worker variable", async () => {
    const get = vi.fn(async () => "store-app-id")
    await expect(
      resolveSfuAppId({
        SFU_APP_ID: "worker-app-id",
        SFU_APP_ID_STORE: { get },
      })
    ).resolves.toBe("worker-app-id")
    expect(get).not.toHaveBeenCalled()
  })

  it("uses the pre-provisioned Secrets Store fallback", async () => {
    const get = vi.fn(async () => "store-app-id")
    await expect(resolveSfuAppId({ SFU_APP_ID_STORE: { get } })).resolves.toBe(
      "store-app-id"
    )
    expect(get).toHaveBeenCalledOnce()
  })

  it("fails closed when the binding is absent or unavailable", async () => {
    await expect(resolveSfuAppId({})).resolves.toBeUndefined()
    await expect(
      resolveSfuAppId({
        SFU_APP_ID_STORE: {
          get: async () => Promise.reject(new Error("private")),
        },
      })
    ).resolves.toBeUndefined()
  })
})
