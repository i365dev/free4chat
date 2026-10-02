import { JSDOM } from "jsdom"
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
    expect(srcDoc).toContain("observe(capabilityId)")
    expect(srcDoc).toContain("invoke(capabilityId, action, args = {})")
    expect(srcDoc).toContain('type: "capabilityRequest"')
    expect(srcDoc).toContain("event.isTrusted")
    expect(srcDoc).toContain("activeControlClick = false")
    expect(srcDoc).toContain("controlClickExpiry = setTimeout")
    expect(srcDoc).not.toContain(
      "queueMicrotask(() => { activeControlClick = false; })"
    )
    expect(srcDoc).toContain("window.free4chat")
    expect(srcDoc).toContain("<main><button id=choose>")
  })

  it("accepts one operation from a trusted control click across the event microtask boundary", async () => {
    const result = validateGeneratedRoomAppBundle({
      ...bundle,
      js: `
        window.mountObservation = () => free4chat.capabilities.observe("printer_status");
        document.querySelector("#choose").onclick = () => {
          window.clickObservation = free4chat.capabilities.observe("printer_status");
          window.secondClickObservation = free4chat.capabilities.observe("printer_status");
        };
      `,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const srcDoc = generatedRoomAppSrcDoc(result.bundle)
    const scripts = [...srcDoc.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(2)
    const dom = new JSDOM(srcDoc.replace(/<script>[\s\S]*?<\/script>/g, ""), {
      runScripts: "outside-only",
    })
    const clickListeners: Array<(event: unknown) => void> = []
    const addEventListener = dom.window.addEventListener.bind(dom.window)
    dom.window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === "click" && typeof listener === "function")
        clickListeners.push(listener as (event: unknown) => void)
      return addEventListener(type, listener, options)
    }) as typeof dom.window.addEventListener

    const posted: Array<Record<string, unknown>> = []
    const testWindow = dom.window as unknown as Window & {
      mountObservation: () => Promise<unknown>
      clickObservation: Promise<unknown>
      secondClickObservation: Promise<unknown>
    }
    const port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      start() {},
      postMessage(message: Record<string, unknown>) {
        posted.push(message)
      },
    }
    dom.window.eval(scripts[0][1])
    dom.window.eval(scripts[1][1])
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: {
          type: "room-app-bootstrap",
          appInstanceId: "task:0123abcd",
          bundleRevision: 1,
          handshakeToken: "handshake",
        },
        ports: [port as unknown as MessagePort],
      })
    )
    expect(clickListeners).toHaveLength(1)

    const mountResult = await testWindow.mountObservation()
    expect(mountResult).toMatchObject({ ok: false, error: "unauthorized" })

    // Invoke the registered capture listener with a browser-trusted click,
    // then dispatch the actual DOM click so the generated control handler runs
    // in the same event task, before the expiry timer's next task.
    clickListeners[0]({
      isTrusted: true,
      target: dom.window.document.querySelector("#choose"),
    })
    dom.window.document
      .querySelector("#choose")!
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    await Promise.resolve()

    expect(
      posted.filter((message) => message.type === "capabilityRequest")
    ).toHaveLength(1)
    expect(await testWindow.secondClickObservation).toMatchObject({
      ok: false,
      error: "unauthorized",
    })
    expect(testWindow.clickObservation).toBeInstanceOf(dom.window.Promise)
    dom.window.close()
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
