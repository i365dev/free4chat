import { describe, expect, it } from "vitest"

import { realtimeBaseUrl } from "./realtimeUrl"

describe("realtimeBaseUrl (#275)", () => {
  it("keeps the default production URL byte-identical", () => {
    expect(realtimeBaseUrl({ SFU_APP_ID: "app-id" })).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app-id"
    )
    // appId is still URL-encoded exactly like the historical call site.
    expect(realtimeBaseUrl({ SFU_APP_ID: "app/with-special" })).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app%2Fwith-special"
    )
    expect(realtimeBaseUrl({})).toBeNull()
  })

  it("SFU_RTC_BASE_URL wins over the default when present", () => {
    expect(
      realtimeBaseUrl({
        SFU_APP_ID: "app-id",
        SFU_RTC_BASE_URL: "http://127.0.0.1:1234/v1/apps/app-id",
      })
    ).toBe("http://127.0.0.1:1234/v1/apps/app-id")
  })
})
