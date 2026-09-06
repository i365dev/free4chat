import { test, expect } from "@playwright/test"

/**
 * Real-browser smoke test for the homepage signal-collapse headline.
 *
 * Proves the OBSERVABLE contract in a real engine (not jsdom):
 *  1. the final slogan is present and accessible (aria-label on the h1);
 *  2. the animated span goes through an "active" phase whose text deviates
 *     from the slogan into high-entropy noise;
 *  3. it converges back to the EXACT deterministic slogan and the resolved
 *     phase, guaranteed by the component's hard wall-clock finalize budget.
 *
 * A pre-hydration sampler (addInitScript) records the live className/text
 * timeline so the assertions never depend on page-load timing.
 *
 * Run (from app/):
 *   npm i -D playwright
 *   npx playwright install chromium
 *   npx playwright test e2e/signal-collapse.spec.ts
 *
 * See e2e/README.md.
 */
const SLOGAN = "Open a room.\nBring people and Agents together."
const SLOGAN_SINGLE_LINE = "Open a room. Bring people and Agents together."

test("homepage headline converges from high-entropy noise to the deterministic slogan", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  // Sample the animated node from before hydration so the animation window
  // is captured regardless of load speed.
  await page.addInitScript(() => {
    ;(
      window as unknown as { __sig: Array<{ cls: string; text: string }> }
    ).__sig = []
    const record = () => {
      const el = document.querySelector("h1 .signal-collapse-text")
      if (!el) return
      ;(
        window as unknown as { __sig: Array<{ cls: string; text: string }> }
      ).__sig.push({ cls: el.className, text: el.textContent ?? "" })
    }
    const timer = window.setInterval(record, 25)
    // Keep sampling through the whole animation (~2.5s max).
    window.setTimeout(() => window.clearInterval(timer), 4000)
    record()
  })

  await page.goto("/")

  // 1. Final slogan is initially present and accessible.
  const headline = page.locator("h1")
  await expect(headline).toHaveAttribute("aria-label", /Open a room\./)
  const span = page.locator("h1 .signal-collapse-text")
  await expect(span).toBeVisible()

  // 2+3. Sampled timeline: active noise phase, then exact convergence.
  await page.waitForFunction(() => {
    const sig = (
      window as unknown as { __sig?: Array<{ cls: string; text: string }> }
    ).__sig
    if (!sig || sig.length === 0) return false
    return sig[sig.length - 1].cls.includes("signal-collapse-text--resolved")
  })
  const timeline = await page.evaluate(
    () =>
      (window as unknown as { __sig: Array<{ cls: string; text: string }> })
        .__sig
  )

  const activeSamples = timeline.filter((sample) =>
    sample.cls.includes("signal-collapse-text--active")
  )
  expect(
    activeSamples.length,
    "the headline must spend time in the active noise phase"
  ).toBeGreaterThan(0)
  const deviated = activeSamples.some(
    (sample) => sample.text.replace(/\s+/g, " ").trim() !== SLOGAN_SINGLE_LINE
  )
  expect(deviated, "active phase must deviate from the final slogan").toBe(true)

  const last = timeline[timeline.length - 1]
  expect(last.cls).toContain("signal-collapse-text--resolved")
  expect(last.text).toBe(SLOGAN)
  expect(errors).toEqual([])
})
