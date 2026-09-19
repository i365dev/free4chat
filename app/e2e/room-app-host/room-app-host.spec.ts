import { expect, test, type Locator, type Page } from "@playwright/test"

import {
  FIXTURE_ROOM_APP_EXTRA_IDS,
  FIXTURE_ROOM_APP_EXTRA_LABELS,
  FIXTURE_ROOM_APP_ID,
  FIXTURE_ROOM_APP_ORIGIN,
  FIXTURE_ROOM_APP_PATHS,
  fixtureRoomAppCatalogJson,
} from "../fixtures/room-app-fixture"
import { FIXTURE_ROOM_APP_DOCUMENT } from "../fixtures/fixture-room-app-document"
import {
  enterLocalRoom,
  installMediaShim,
  installMicrophoneCallCounter,
  microphoneRequestCount,
  openLocalRoom,
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
    if (FIXTURE_ROOM_APP_PATHS.includes(pathname)) {
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
const launcherEntry = (page: Page) => page.getByTestId("stage-apps-launcher")
const launcher = (page: Page) => page.getByTestId("room-app-launcher")
const launcherAppButton = (page: Page) =>
  page.getByTestId(`launcher-app-${FIXTURE_ROOM_APP_ID}`)
const stageAppButton = (page: Page) =>
  page.getByTestId(`stage-app-${FIXTURE_ROOM_APP_ID}`)

/**
 * #98: the Stage strip no longer renders the whole Lab catalog. Opening an App
 * is still one action — it is just the launcher entry plus the App row — so the
 * compatibility gate goes through the same progressive-disclosure surface a
 * Human uses instead of assuming a permanent chip per App.
 */
async function openRoomAppFromLauncher(page: Page) {
  await expect(launcherEntry(page)).toBeVisible()
  await launcherEntry(page).click()
  await expect(launcher(page)).toBeVisible()
  await expect(launcherAppButton(page)).toBeVisible()
  await launcherAppButton(page).click()
  // Selection closes the launcher: one quick action, no lingering surface.
  await expect(launcher(page)).toHaveCount(0)
}
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

const roomStage = (page: Page) => page.getByTestId("room-stage")
const roomContent = (page: Page) => page.locator(".room-content")

/**
 * The real-iPad regression was structural, not geometric: fullscreen kept the
 * Stage at its normal split width and relied on a `position: fixed` descendant
 * escaping that clipped, overflow-hidden ancestor. iPad Safari clips that
 * escape, which cut off the host's right-side chrome. Emulated WebKit paints it
 * correctly, so assert the LAYOUT OWNERSHIP instead of the painted result:
 * while focus mode is active the Stage itself must own the whole Room content
 * region, and the resident host must fill that Stage.
 */
async function expectFullscreenStageOwnsRoomContent(page: Page) {
  const stage = await roomStage(page).boundingBox()
  const content = await roomContent(page).boundingBox()
  const hostBox = await host(page).boundingBox()
  expect(stage, "room-stage must have a bounding box").not.toBeNull()
  expect(content, ".room-content must have a bounding box").not.toBeNull()
  expect(hostBox, "room-app-host must have a bounding box").not.toBeNull()
  expect(
    Math.abs(stage!.x - content!.x),
    `fullscreen room-stage must start at the Room content left edge (stage ${
      stage!.x
    }, content ${content!.x})`
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(
    Math.abs(stage!.width - content!.width),
    `fullscreen room-stage must own the full Room content width (stage ${
      stage!.width
    }, content ${content!.width})`
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(
    Math.abs(stage!.x + stage!.width - (content!.x + content!.width)),
    "fullscreen room-stage must reach the Room content right edge"
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(
    Math.abs(hostBox!.x - stage!.x),
    "the resident host must fill the fullscreen Stage horizontally"
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(
    Math.abs(hostBox!.width - stage!.width),
    `the resident host must fill the fullscreen Stage width (host ${
      hostBox!.width
    }, stage ${stage!.width})`
  ).toBeLessThanOrEqual(TOLERANCE)
  // Vertical ownership too; the Stage carries a 1px border at the sub-md
  // breakpoint, hence the slightly looser bound.
  expect(
    Math.abs(hostBox!.y - stage!.y),
    "the resident host must start at the fullscreen Stage top"
  ).toBeLessThanOrEqual(2)
  expect(
    stage!.height - hostBox!.height,
    "the resident host must fill the fullscreen Stage height"
  ).toBeLessThanOrEqual(2)
  // A focus-mode Stage must never keep the normal split width while the right
  // pane is hidden.
  expect(stage!.width).toBeGreaterThan(content!.width * 0.9)
}

/**
 * The two-pane Stage/Chat split only exists at or above Core's `md` breakpoint.
 * Below it the Room is a single column and the Stage already owns the whole
 * content region, so the normal-layout assertion must follow that contract
 * instead of assuming a split everywhere.
 */
function isTwoPaneRoom(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 768
}

async function expectNormalStageLayout(page: Page) {
  const stage = await roomStage(page).boundingBox()
  const content = await roomContent(page).boundingBox()
  expect(stage, "room-stage must have a bounding box").not.toBeNull()
  expect(content, ".room-content must have a bounding box").not.toBeNull()
  if (isTwoPaneRoom(page)) {
    expect(
      stage!.width,
      "normal Room layout must keep the Stage at its split width"
    ).toBeLessThan(content!.width)
    return
  }
  expect(
    Math.abs(stage!.width - content!.width),
    "single-column Room layout has no Stage/Chat split"
  ).toBeLessThanOrEqual(TOLERANCE)
}

/**
 * Pins the iframe DOM node and reports whether it is still the same element.
 * A fullscreen toggle must be visual ownership only: no reload, no remount.
 */
async function pinIframeIdentity(page: Page, marker: string) {
  await page.evaluate((value) => {
    const frame = document.querySelector('[data-testid="room-app-iframe"]')
    if (!frame) throw new Error("room-app-iframe missing")
    ;(window as unknown as Record<string, unknown>).__hostCompatIframe = frame
    frame.setAttribute("data-host-compat-identity", value)
  }, marker)
}

async function iframeIdentityStatus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-testid="room-app-iframe"]')
    const pinned = (window as unknown as Record<string, unknown>)
      .__hostCompatIframe
    if (!frame || !pinned) return "missing"
    if (frame !== pinned) return "replaced"
    return frame.getAttribute("data-host-compat-identity") ?? "unmarked"
  })
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
  let fixtureSession: string | null = null

  await test.step("join the local Room", async () => {
    await installFixtureRoomApp(page)
    await installExternalRuntimeStubs(page)
    // No OS microphone, no permission prompt, identical on every engine.
    await installMediaShim(page)
    // #402: this whole suite is a non-voice Room App flow. Joining must never
    // ask for microphone permission, so no synthetic device is installed at
    // all — only a counter that proves no request happened.
    await installMicrophoneCallCounter(page)
    await openLocalRoom(page, roomSlug)
    expect(
      await microphoneRequestCount(page),
      "opening a Room must not request microphone access"
    ).toBe(0)
    await enterLocalRoom(page, "Alice")
    await expect(page.getByTestId("room-stage")).toBeVisible()
    await expect(page.getByTestId("room-timeline")).toBeVisible()
    await expectNoPageOverflow(page, "joined Room")
  })

  await test.step("open the fixture Room App through the real host boundary", async () => {
    // A fresh Room starts with no recent Apps: the strip is the launcher entry
    // alone, and nothing is inline until something is actually opened.
    await expect(launcherEntry(page)).toBeVisible()
    await expect(stageAppButton(page)).toHaveCount(0)
    await openRoomAppFromLauncher(page)
    // The opened App is now both the current Stage App and an inline shortcut.
    await expect(stageAppButton(page)).toBeVisible()
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

    // Normal Room layout: at md+ the Stage owns only its share of the content.
    await expectNormalStageLayout(page)

    // Pin everything a fullscreen toggle must NOT recreate: the iframe DOM
    // node, the App's bootstrap session token, and some App-local state.
    await pinIframeIdentity(page, "before-fullscreen")
    await fixtureFrame().getByTestId("fixture-tick").click()
    await expect(fixtureFrame().getByTestId("fixture-ticks")).toHaveText("1")
    fixtureSession = await fixtureFrame()
      .getByTestId("fixture-session")
      .textContent()
    expect(fixtureSession).toMatch(/^[a-z0-9]{6,}$/)
  })

  await test.step("enter App fullscreen and keep the exit control reachable", async () => {
    await enterControl(page).click()
    await expect(host(page)).toHaveAttribute("data-layout", "fullscreen")
    // Structural ownership: the Stage itself, not a fixed descendant, fills
    // the Room content region while the right pane is hidden.
    await expectFullscreenStageOwnsRoomContent(page)
    // Focus mode is visual ownership only: same iframe node, same bootstrap
    // session, same App-local state.
    expect(await iframeIdentityStatus(page)).toBe("before-fullscreen")
    await expect(fixtureFrame().getByTestId("fixture-session")).toHaveText(
      fixtureSession!
    )
    await expect(fixtureFrame().getByTestId("fixture-ticks")).toHaveText("1")
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
    // The exact normal Room layout returns, and the App was never reloaded.
    await expectNormalStageLayout(page)
    expect(await iframeIdentityStatus(page)).toBe("before-fullscreen")
    await expect(fixtureFrame().getByTestId("fixture-session")).toHaveText(
      fixtureSession!
    )
    await expect(fixtureFrame().getByTestId("fixture-ticks")).toHaveText("1")
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
    // It stayed current/recent, so the one-action inline shortcut is enough.
    await expect(stageAppButton(page)).toBeVisible()
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

  await test.step("the launcher is a searchable, bounded catalog surface", async () => {
    // Start from the Room: the launcher must be reachable without an App open.
    await host(page).getByRole("button", { name: "Close" }).click()
    await expect(appIframe(page)).toBeHidden()
    await launcherEntry(page).click()
    await expect(launcher(page)).toBeVisible()

    // The whole supplied catalog stays reachable — not just the Apps this Room
    // happened to open — with the canonical catalog labels.
    await expect(launcherAppButton(page)).toBeVisible()
    for (const [index, id] of FIXTURE_ROOM_APP_EXTRA_IDS.entries()) {
      const row = page.getByTestId(`launcher-app-${id}`)
      await expect(row).toBeVisible()
      await expect(row).toContainText(FIXTURE_ROOM_APP_EXTRA_LABELS[index])
    }
    await expect(launcher(page).getByRole("menuitem")).toHaveCount(
      FIXTURE_ROOM_APP_EXTRA_IDS.length + 1
    )

    // The search box really filters the catalog, and says so when nothing
    // matches instead of rendering an empty box.
    const search = page.getByTestId("room-app-search")
    await search.fill("no such Room App")
    await expect(page.getByTestId("room-app-search-empty")).toBeVisible()
    await expect(launcherAppButton(page)).toHaveCount(0)
    await search.fill("")
    await expect(launcherAppButton(page)).toBeVisible()

    // The 390px profile must not be able to push the launcher off-screen.
    await expectInsideViewport(page, launcher(page), "Room App launcher")
    await expectNoPageOverflow(page, "launcher open")

    // Keyboard path: type to filter, then open with Enter alone.
    await search.fill("fixture")
    await search.press("Enter")
    await expect(launcher(page)).toHaveCount(0)
    await expect(appIframe(page)).toBeVisible()
    await expect(host(page)).toHaveAttribute("data-layout", "stage")
    await expectNoPageOverflow(page, "opened by keyboard")
  })

  await test.step("the fixture App stays interactive inside the sandbox", async () => {
    const fixture = fixtureFrame()
    await expect(fixture.getByTestId("fixture-participants")).toHaveText("1")
    // "fixture-ticks" was already incremented to 1 before fullscreen, and every
    // click/outbound message adds one: the App-local state carried through the
    // whole focus-mode round trip.
    await fixture.getByTestId("fixture-tick").click()
    await expect(fixture.getByTestId("fixture-ticks")).toHaveText("2")
    // One deterministic outbound host message through the real MessagePort.
    await fixture.getByTestId("fixture-ping").click()
    await expect(fixture.getByTestId("fixture-ticks")).toHaveText("3")
    await expect(fixture.getByTestId("fixture-session")).toHaveText(
      fixtureSession!
    )
    await expect(appIframe(page)).toBeVisible()
  })

  await test.step("the whole non-voice session never requested a microphone", async () => {
    // join -> open App -> fullscreen -> exit -> hide -> reopen -> interact,
    // all without a single microphone request or permission prompt.
    expect(
      await microphoneRequestCount(page),
      "the non-voice Room App session must not request microphone access"
    ).toBe(0)
    expect(pageErrors, "unexpected page errors").toEqual([])
    expect(consoleErrors, "unexpected console errors").toEqual([])
  })
})
