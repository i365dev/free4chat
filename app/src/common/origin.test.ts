import { describe, expect, it } from "vitest"

import { isAllowedOrigin } from "./origin"

describe("isAllowedOrigin", () => {
  it("allows only the configured site origin", () => {
    expect(isAllowedOrigin("https://zchat.bfzone.ccwu.cc")).toBe(true)
    expect(isAllowedOrigin("https://free4.chat")).toBe(false)
    expect(isAllowedOrigin("https://www.free4.chat")).toBe(false)
    expect(isAllowedOrigin("http://localhost:3000")).toBe(false)
    expect(isAllowedOrigin(null)).toBe(false)
  })
})
