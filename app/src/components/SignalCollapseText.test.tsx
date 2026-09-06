import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import SignalCollapseText from "./SignalCollapseText"

const SLOGAN = "Open a room.\nBring people and Agents together."

// jsdom has no requestAnimationFrame; drive the rAF loop manually so the
// convergence state machine is tested deterministically in real time.
type RafCallback = (now: number) => void
let rafCallbacks: Array<RafCallback>
let rafNextId: number
let nowMs: number

beforeEach(() => {
  rafCallbacks = []
  rafNextId = 1
  nowMs = 0
  vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => {
    rafCallbacks.push(cb)
    return rafNextId++
  })
  vi.stubGlobal("cancelAnimationFrame", () => undefined)
  // jsdom's window.performance is an accessor; spy on the callable instead.
  vi.spyOn(window.performance, "now").mockImplementation(() => nowMs)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function advanceFrames(deltaMs: number, frames: number) {
  for (let frame = 0; frame < frames; frame += 1) {
    const callbacks = rafCallbacks.splice(0)
    nowMs += deltaMs
    act(() => {
      // rAF callbacks receive the frame timestamp (DOMHighResTimeStamp).
      for (const cb of callbacks) cb(nowMs)
    })
  }
}

describe("SignalCollapseText lifecycle", () => {
  it("starts from the final slogan, swaps to noise, then converges back to the exact slogan", () => {
    render(<SignalCollapseText text={SLOGAN} className="psy-headline" />)
    const span = screen.getByText((content) => content.length > 0, {
      selector: ".signal-collapse-text",
    })

    // The layout effect immediately swaps to noise and marks active.
    expect(span.className).toContain("signal-collapse-text--active")
    expect(span.textContent).not.toBe(SLOGAN)

    // Phase 2: drive ~1.1s of frames; glyphs converge.
    advanceFrames(34, 34)

    // Phase 3: after the hard budget the exact slogan is guaranteed.
    advanceFrames(60, 40) // total > FINALIZE_MS
    expect(span.className).toContain("signal-collapse-text--resolved")
    expect(span.textContent).toBe(SLOGAN)
    expect(span.className).toContain("signal-collapse-text--resolved")
    expect(span.textContent).toBe(SLOGAN)
  })

  it("resolves within the absolute budget even if frames stall (frozen-timer recovery)", () => {
    render(<SignalCollapseText text={SLOGAN} className="psy-headline" />)
    const span = screen.getByText((content) => content.length > 0, {
      selector: ".signal-collapse-text",
    })

    // Simulate a long freeze: the next frame arrives a very long time later.
    const frozen = rafCallbacks.splice(0)
    nowMs += 20_000 // e.g. iOS timer clamp / background freeze / bfcache restore
    act(() => {
      for (const cb of frozen) cb(nowMs)
    })
    expect(span.className).toContain("signal-collapse-text--resolved")
    expect(span.textContent).toBe(SLOGAN)
  })

  it("shows the final slogan immediately for reduced-motion users", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true })
    vi.stubGlobal("matchMedia", matchMedia)

    render(<SignalCollapseText text={SLOGAN} className="psy-headline" />)
    const span = screen.getByText((content) => content.length > 0, {
      selector: ".signal-collapse-text",
    })

    // Still idle: no active/noise phase ever happens.
    expect(span.className).toContain("signal-collapse-text--idle")
    expect(span.textContent).toBe(SLOGAN)
    expect(rafCallbacks.length).toBe(0)
  })
})
