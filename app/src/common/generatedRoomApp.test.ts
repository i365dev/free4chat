import { describe, expect, it } from "vitest"

import {
  generatedRoomAppSrcDoc,
  MAX_GENERATED_APP_BUNDLE_BYTES,
  validateGeneratedRoomAppBundle,
  validateGeneratedRoomAppState,
} from "./generatedRoomApp"

const bundle = {
  version: 1 as const,
  manifest: { title: "Decision matrix", networkOrigins: [] as [] },
  html: "<main><button id=choose>Choose</button><output id=result></output></main>",
  css: "main { font: 16px sans-serif; }",
  js: "document.querySelector('#choose').onclick = () => { document.querySelector('#result').textContent = 'ready' }",
  initialState: { choice: null },
}

describe("generated Task Room App contract", () => {
  it("accepts the bounded V0 bundle and creates an opaque-origin bridge document", () => {
    const result = validateGeneratedRoomAppBundle(bundle)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bytes).toBeLessThanOrEqual(MAX_GENERATED_APP_BUNDLE_BYTES)

    const srcDoc = generatedRoomAppSrcDoc(result.bundle)
    expect(srcDoc).toContain("connect-src 'none'")
    expect(srcDoc).toContain("sendGeneratedState")
    expect(srcDoc).toContain("window.free4chat")
    expect(srcDoc).toContain("<main><button id=choose>")
  })

  it("rejects extension fields, network origins, and executable script terminators", () => {
    expect(validateGeneratedRoomAppBundle({ ...bundle, extra: true })).toEqual({
      ok: false,
      error: "generated_app_bundle_invalid",
    })
    expect(
      validateGeneratedRoomAppBundle({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          networkOrigins: ["https://example.com"],
        },
      })
    ).toEqual({ ok: false, error: "generated_app_bundle_invalid" })
    expect(
      validateGeneratedRoomAppBundle({
        ...bundle,
        js: "</script><script>alert(1)",
      })
    ).toEqual({ ok: false, error: "generated_app_bundle_invalid" })
  })

  it("keeps shared state JSON-only and bounded", () => {
    expect(validateGeneratedRoomAppState({ count: 1 })).toMatchObject({
      ok: true,
    })
    expect(validateGeneratedRoomAppState([])).toEqual({
      ok: false,
      error: "generated_app_state_invalid",
    })
    expect(
      validateGeneratedRoomAppState({ text: "x".repeat(16 * 1024) })
    ).toEqual({ ok: false, error: "generated_app_state_invalid" })
  })
})
