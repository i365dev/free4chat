import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  FIXTURE_ROOM_APP_ID,
  FIXTURE_ROOM_APP_ORIGIN,
  FIXTURE_ROOM_APP_PATH,
  fixtureRoomAppCatalogJson,
} from "../fixtures/room-app-fixture"
import { FIXTURE_ROOM_APP_DOCUMENT } from "../fixtures/fixture-room-app-document"
import {
  installSyntheticMicrophone,
  joinLocalRoom,
} from "../fixtures/local-room"

/**
 * Core Room App host compatibility gate (#398).
 *
 * Owned by Core, deliberately narrow: it proves the GENERIC host contract —
 * catalog lookup, iframe sandbox, bootstrap handshake, host chrome, fullscreen
 * focus mode, hide/reopen — on desktop / phone / tablet viewports. It does not
 * test any Lab App's business behaviour, and it never touches production.
 *
 * Only the network *responses* are local: the fixture catalog and the fixture
 * App document are fulfilled at the real trusted origin, while Core's catalog
 * loader, schema validation, origin allow-list, iframe sandbox, bootstrap
 * handshake and MessagePort bridge stay production code.
 */

/** Geometry assertions allow sub-pixel rounding, never real overflow. */
const TOLERANCE = 1

/** A Stage-hosted iframe must be a real surface, not a collapsed box. */
const MIN_IFRAME_WIDTH = 200
const MIN_IFRAME_HEIGHT = 120

/** External runtime resources used by the production document. Fulfilling them
 * locally keeps this gate hermetic (no Google Fonts, no analytics) and keeps CI
 * traffic out of the production analytics property. Content types must match
 * what the document requested: WebKit refuses a stylesheet served as script. */
const EXTERNAL_RUNTIME_RESOURCES: Array<{
  pattern: string
  contentType: string
}> = [
  { pattern: "https://fonts.googleapis.com/**", contentType: "text/css" },
  { pattern: "https://fonts.gstatic.com/**", contentType: "font/woff2" },
  { pattern: "https://umami.bmpi.dev/**", contentType: "text/javascript" },
  {
    pattern: "https://www.googletagmanager.com/**",
    contentType: "text/javascript",
  },
  {
    pattern: "https://www.google-analytics.com/**",
    contentType: "text/javascript",
  },
]

function installExternalRuntimeStubs(page: Page) {
  return Promise.all(
    EXTERNAL_RUNTIME_RESOURCES.map(({ pattern, contentType }) =>
      page.route(pattern, (route) =>
        route.fulfill({ status: 200, contentType, body: "" })
      )
    )
  )
}

/** Serves the fixture catalog and the fixture App at the trusted App origin. */
async function installFixtureRoomApp(page: Page) {
  await page.route(`${FIXTURE_ROOM_APP_ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname === "/_catalog.json") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: fixtureRoomAppCatalogJson(),
      })
      return
    }
    if (pathname === FIXTURE_ROOM_APP_PATH) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: FIXTURE_ROOM_APP_DOCUMENT,
      })
      return
    }
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "fixture: no such resource",
    })
  })
}

const host = (page: Page) => page.getByTestId("room-app-host")
const appIframe = (page: Page) => page.getByTestId("room-app-iframe")
const stageAppButton = (page: Page) =>
  page.getByTestId(`stage-app-${FIXTURE_ROOM_APP_ID}`)
const exitControl = (page: Page) =>
  page.locator(
    '[data-testid="room-app-host"] button[aria-label="Exit fullscreen"]'
  )
const enterControl = (page: Page) =>
  page.locator('[data-testid="room-app-host"] button[aria-label="Fullscreen"]')

/** The control must fit inside the profile's viewport, not merely exist. */
async function expectInsideViewport(page: Page, target: Locator, what: string) {
  const viewport = page.viewportSize()
  expect(
    viewport,
    "every profile must define an explicit viewport"
  ).not.toBeNull()
  const box = await target.boundingBox()
  expect(box, `${what} must have a bounding box`).not.toBeNull()
  const { x, y, width, height } = box!
  expect(x, `${what}: left edge inside viewport`).toBeGreaterThanOrEqual(
    -TOLERANCE
  )
  expect(y, `${what}: top edge inside viewport`).toBeGreaterThanOrEqual(
    -TOLERANCE
  )
  expect(
    x + width,
    `${what}: right edge inside viewport (${viewport!.width}px)`
  ).toBeLessThanOrEqual(viewport!.width + TOLERANCE)
  expect(
    y + height,
    `${what}: bottom edge inside viewport (${viewport!.height}px)`
  ).toBeLessThanOrEqual(viewport!.height + TOLERANCE)
  return box!
}

/** Visibility is not reachability: the control must be the topmost hit target. */
async function expectReceivesPointer(
  page: Page,
  target: Locator,
  what: string
) {
  const box = await target.boundingBox()
  expect(box, `${what} must have a bounding box`).not.toBeNull()
  const center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    if (!element) return null
    const button = element.closest("button")
    return {
      tag: element.tagName,
      label: button?.getAttribute("aria-label") ?? null,
    }
  }, center)
  expect(
    hit?.label,
    `${what} must own the pointer at its center (hit ${
      hit ? hit.tag : "nothing"
    })`
  ).toBe("Exit fullscreen")
}

/** Room-level horizontal overflow is a layout failure; local scrollers are not. */
async function expectNoPageOverflow(page: Page, what: string) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(
    metrics.scrollWidth,
    `${what}: no page-level horizontal overflow`
  ).toBeLessThanOrEqual(metrics.clientWidth + TOLERANCE)
}

test("Room App host contract survives open, fullscreen, exit, hide and reopen", async ({
  page,
}, testInfo) => {
  const profile = testInfo.project.name
  const roomSlug = `compat-${profile}-${Date.now().toString(36)}`
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  const fixtureFrame = () =>
    page.frameLocator('[data-testid="room-app-iframe"]')

  await test.step("join the local Room", async () => {
    await installFixtureRoomApp(page)
    await installExternalRuntimeStubs(page)
    // No OS microphone, no permission prompt, identical on every engine.
    await installSyntheticMicrophone(page)
    await joinLocalRoom(page, roomSlug, "Alice")
    // Locks the media seam: the join must have used the synthetic microphone,
    // never a real device or a permission prompt.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __roomAppHostCompatMic?: string })
            .__roomAppHostCompatMic
      )
    ).toBe("synthetic")
    await expect(page.getByTestId("room-stage")).toBeVisible()
    await expect(page.getByTestId("room-timeline")).toBeVisible()
    await expectNoPageOverflow(page, "joined Room")
  })

  await test.step("open the fixture Room App through the real host boundary", async () => {
    await expect(stageAppButton(page)).toBeVisible()
    await stageAppButton(page).click()
    await expect(appIframe(page)).toBeVisible()
    await expect(host(page)).toHaveAttribute("data-layout", "stage")
    // The real bootstrap handshake completed inside the real sandbox.
    await expect(host(page).getByText("ready")).toBeVisible()
    await expect(fixtureFrame().getByTestId("fixture-status")).toHaveText(
      "ready"
    )
    await expect(host(page).getByText("Core Fixture App")).toBeVisible()
  })

  await test.step("the App iframe has sensible geometry and the Room shell survives", async () => {
    const box = await appIframe(page).boundingBox()
    expect(box, "App iframe must have a bounding box").not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(MIN_IFRAME_WIDTH)
    expect(box!.height).toBeGreaterThanOrEqual(MIN_IFRAME_HEIGHT)
    await expectInsideViewport(page, appIframe(page), "App iframe")
    await expectInsideViewport(
      page,
      host(page).getByRole("button", { name: "Fullscreen" }),
      "fullscreen control"
    )
    // Opening the App must not destroy the Room conversation.
    await expect(page.getByTestId("interaction-tablist")).toBeVisible()
    await expectNoPageOverflow(page, "App visible")
  })

  await test.step("enter App fullscreen and keep the exit control reachable", async () => {
    await enterControl(page).click()
    await expect(host(page)).toHaveAttribute("data-layout", "fullscreen")
    const exit = exitControl(page)
    await expect(exit).toBeVisible()
    await expect(exit).toBeEnabled()
    await expectInsideViewport(page, exit, "fullscreen exit control")
    await expectReceivesPointer(page, exit, "fullscreen exit control")
    // The focused App surface still owns a real iframe.
    await expect(appIframe(page)).toBeVisible()
    const box = await appIframe(page).boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(MIN_IFRAME_WIDTH)
    expect(box!.height).toBeGreaterThanOrEqual(MIN_IFRAME_HEIGHT)
    await expectNoPageOverflow(page, "App fullscreen")
  })

  await test.step("App content scrolling never pushes the exit control out of reach", async () => {
    // The fixture has an inner scroller AND a document taller than the frame.
    await fixtureFrame()
      .getByTestId("fixture-scroll")
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
    await fixtureFrame()
      .getByTestId("fixture-rows")
      .evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight)
      })
    await expectInsideViewport(
      page,
      exitControl(page),
      "fullscreen exit control after App scroll"
    )
    await expectReceivesPointer(
      page,
      exitControl(page),
      "fullscreen exit control after App scroll"
    )
    await expectNoPageOverflow(page, "App scrolled")
  })

  await test.step("exit fullscreen and recover the Room shell", async () => {
    // A real click: it only works if the control is genuinely reachable.
    await exitControl(page).click()
    await expect(host(page)).toHaveAttribute("data-layout", "stage")
    await expect(exitControl(page)).toHaveCount(0)
    await expect(page.getByTestId("room-stage")).toBeVisible()
    await expect(page.getByTestId("room-timeline")).toBeVisible()
    await expect(appIframe(page)).toBeVisible()
    await expectNoPageOverflow(page, "after exit fullscreen")
  })

  await test.step("hide the App and keep the Room usable", async () => {
    await host(page).getByRole("button", { name: "Close" }).click()
    await expect(appIframe(page)).toBeHidden()
    await expect(page.getByTestId("room-stage")).toBeVisible()
    await expect(page.getByTestId("room-timeline")).toBeVisible()
    await expect(page.getByTestId("room-stage-participants")).toBeVisible()
    await expectNoPageOverflow(page, "App hidden")
  })

  await test.step("reopen the App without a stale fullscreen state", async () => {
    await stageAppButton(page).click()
    await expect(appIframe(page)).toBeVisible()
    await expect(host(page)).toHaveAttribute("data-layout", "stage")
    await expect(host(page).getByText("ready")).toBeVisible()
    await expect(fixtureFrame().getByTestId("fixture-status")).toHaveText(
      "ready"
    )
    await expectInsideViewport(
      page,
      host(page).getByRole("button", { name: "Fullscreen" }),
      "fullscreen control after reopen"
    )
    await expectNoPageOverflow(page, "App reopened")
  })

  await test.step("the fixture App stays interactive inside the sandbox", async () => {
    const fixture = fixtureFrame()
    await expect(fixture.getByTestId("fixture-participants")).toHaveText("1")
    await fixture.getByTestId("fixture-tick").click()
    await expect(fixture.getByTestId("fixture-ticks")).toHaveText("1")
    // One deterministic outbound host message through the real MessagePort.
    await fixture.getByTestId("fixture-ping").click()
    await expect(fixture.getByTestId("fixture-ticks")).toHaveText("2")
    await expect(appIframe(page)).toBeVisible()
  })

  await test.step("no unexpected page or console errors", async () => {
    expect(pageErrors, "unexpected page errors").toEqual([])
    expect(consoleErrors, "unexpected console errors").toEqual([])
  })
})
