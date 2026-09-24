import { expect, test } from "@playwright/test"

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet portrait", width: 768, height: 1024 },
  { name: "tablet landscape", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
]

test("homepage keeps document scrolling available without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/")
  await expect(page.locator("h1")).toBeVisible()

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    })
    await page.evaluate(() => window.scrollTo(0, 0))

    const geometry = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }))

    expect(
      geometry.scrollWidth,
      `${viewport.name} (${viewport.width}px) must not scroll horizontally`
    ).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(
      geometry.scrollHeight,
      `${viewport.name} must have page content below the initial viewport`
    ).toBeGreaterThan(geometry.viewportHeight)

    const wheelAndExpectDocumentToMove = async (
      name: string,
      x: number,
      y: number
    ) => {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.mouse.move(x, y)
      const before = await page.evaluate(() => window.scrollY)
      await page.mouse.wheel(0, 240)
      await expect
        .poll(() => page.evaluate(() => window.scrollY), {
          message: `${name} at ${viewport.width}px should scroll the document`,
        })
        .toBeGreaterThan(before)
    }

    const hero = await page.locator(".home-cosmic-hero").boundingBox()
    expect(hero, `${viewport.name} hero should be laid out`).not.toBeNull()

    // Header.tsx contains metadata only, so the top introductory line is the
    // actual top-of-page interaction area available to a user.
    await wheelAndExpectDocumentToMove(
      "top intro",
      viewport.width / 2,
      Math.max(1, Math.min(hero!.y + 12, viewport.height - 1))
    )
    await wheelAndExpectDocumentToMove(
      "hero",
      viewport.width / 2,
      Math.max(1, Math.min(hero!.y + hero!.height / 2, viewport.height - 1))
    )

    // Move to the lower half while leaving room to scroll farther, then wheel
    // over page content rather than relying on a specific link or footer.
    await page.evaluate(() => {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo(0, Math.floor(maxScroll * 0.45))
    })
    const lowerStart = await page.evaluate(() => window.scrollY)
    await page.mouse.move(viewport.width / 2, Math.floor(viewport.height * 0.8))
    await page.mouse.wheel(0, 240)
    await expect
      .poll(() => page.evaluate(() => window.scrollY), {
        message: `lower page at ${viewport.width}px should scroll the document`,
      })
      .toBeGreaterThan(lowerStart)
  }
})
