import { expect, test } from "@playwright/test"

import {
  FIXTURE_ROOM_APP_EXTRA_IDS,
  FIXTURE_ROOM_APP_ID,
  FIXTURE_ROOM_APP_LABEL,
  FIXTURE_ROOM_APP_ORIGIN,
  FIXTURE_ROOM_APP_PATHS,
  fixtureRoomAppCatalogJson,
} from "../fixtures/room-app-fixture"
import { FIXTURE_ROOM_APP_DOCUMENT } from "../fixtures/fixture-room-app-document"
import {
  enterLocalRoom,
  installMediaShim,
  openLocalRoom,
} from "../fixtures/local-room"

/**
 * #98 visual smoke: screenshots of the progressive-disclosure launcher on a
 * desktop viewport and at ~390px. Not a CI gate — the semantic gate is
 * `room-app-host.spec.ts`. This file exists so a human can review the actual
 * pixels of the launcher, its search results and the phone surface.
 */

const ARTIFACT_DIR =
  process.env.LAUNCHER_SMOKE_DIR ?? "test-results/launcher-smoke"

/**
 * Printed browser observations. This run's model/human reviewer cannot see the
 * PNGs directly, so the geometry is reported as data: the launcher must fit the
 * viewport at both widths, the strip must stay one compact row, and the Room
 * must never gain page-level horizontal overflow.
 */
async function reportLayout(
  page: import("@playwright/test").Page,
  label: string
) {
  const snapshot = await page.evaluate(() => {
    const box = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`)
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }
    }
    const strip = document.querySelector('[data-testid="stage-switcher"]')
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      pageOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      strip: strip
        ? {
            classNameHasLocalScroll:
              strip.className.includes("overflow-x-auto"),
            scrollWidth: strip.scrollWidth,
            clientWidth: strip.clientWidth,
            rows: new Set(
              Array.from(strip.children).map((child) =>
                Math.round(child.getBoundingClientRect().top)
              )
            ).size,
          }
        : null,
      inlineChips: Array.from(
        document.querySelectorAll('button[data-testid^="stage-app-"]')
      ).map((chip) => chip.getAttribute("data-testid")),
      launcherEntry: box("stage-apps-launcher"),
      launcher: box("room-app-launcher"),
      launcherRows: Array.from(
        document.querySelectorAll('[data-testid^="launcher-app-"]')
      ).map((row) => ({
        id: row.getAttribute("data-testid"),
        w: Math.round(row.getBoundingClientRect().width),
      })),
      iframe: box("room-app-iframe"),
    }
  })
  // eslint-disable-next-line no-console
  console.log(`[launcher-smoke] ${label} ${JSON.stringify(snapshot)}`)
  return snapshot
}

async function installFixtureRoomApp(page: import("@playwright/test").Page) {
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
    await route.fulfill({ status: 404, body: "fixture: no such resource" })
  })
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" })
  )
  await page.route("https://fonts.gstatic.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "font/woff2", body: "" })
  )
  await page.route("https://umami.bmpi.dev/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" })
  )
  await page.route("https://www.googletagmanager.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" })
  )
  await page.route("https://www.google-analytics.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" })
  )
}

async function joinRoom(page: import("@playwright/test").Page, slug: string) {
  await installFixtureRoomApp(page)
  await installMediaShim(page)
  await openLocalRoom(page, slug)
  await enterLocalRoom(page, "Alice")
  await expect(page.getByTestId("room-stage")).toBeVisible()
}

test("launcher smoke: desktop and ~390px", async ({ page }) => {
  const slug = `smoke-${Date.now().toString(36)}`

  await test.step("desktop 1280x800 — Room with the launcher entry only", async () => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await joinRoom(page, slug)
    await expect(page.getByTestId("stage-apps-launcher")).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/01-desktop-room.png`,
      fullPage: false,
    })
  })

  await test.step("desktop — launcher listing the whole catalog", async () => {
    await page.getByTestId("stage-apps-launcher").click()
    await expect(page.getByTestId("room-app-launcher")).toBeVisible()
    for (const id of FIXTURE_ROOM_APP_EXTRA_IDS)
      await expect(page.getByTestId(`launcher-app-${id}`)).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/02-desktop-launcher.png`,
      fullPage: false,
    })
    const layout = await reportLayout(page, "desktop-launcher")
    expect(layout.launcher).not.toBeNull()
    expect(layout.launcher!.x).toBeGreaterThanOrEqual(0)
    expect(layout.launcher!.x + layout.launcher!.w).toBeLessThanOrEqual(
      layout.viewport.w
    )
    expect(layout.launcher!.y + layout.launcher!.h).toBeLessThanOrEqual(
      layout.viewport.h
    )
    // Exactly one row of launcher results and no page-level overflow.
    expect(layout.pageOverflow).toBeLessThanOrEqual(0)
    expect(
      new Set(layout.launcherRows.map((row) => row.w)).size
    ).toBeLessThanOrEqual(1)
  })

  await test.step("desktop — search filtering and the empty state", async () => {
    const search = page.getByTestId("room-app-search")
    await search.fill("third")
    await expect(
      page.getByTestId("launcher-app-fixture-third-app")
    ).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/03-desktop-search.png`,
      fullPage: false,
    })
    await search.fill("zzzz")
    await expect(page.getByTestId("room-app-search-empty")).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/04-desktop-search-empty.png`,
      fullPage: false,
    })
    await search.fill(FIXTURE_ROOM_APP_LABEL)
    await search.press("Enter")
  })

  await test.step("desktop — opened App with a bounded inline strip", async () => {
    await expect(page.getByTestId("room-app-iframe")).toBeVisible()
    await expect(
      page.getByTestId(`stage-app-${FIXTURE_ROOM_APP_ID}`)
    ).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/05-desktop-app-open.png`,
      fullPage: false,
    })
    const layout = await reportLayout(page, "desktop-app-open")
    // The strip stays a single compact row that is a LOCAL scroller.
    expect(layout.strip!.classNameHasLocalScroll).toBe(true)
    expect(layout.strip!.rows).toBe(1)
    expect(layout.inlineChips).toEqual([`stage-app-${FIXTURE_ROOM_APP_ID}`])
    expect(layout.pageOverflow).toBeLessThanOrEqual(0)
  })

  await test.step("desktop — reopen the launcher with this Room's recent App", async () => {
    await page.getByTestId("stage-apps-launcher").click()
    await expect(page.getByTestId("room-app-launcher-recent")).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/06-desktop-launcher-recent.png`,
      fullPage: false,
    })
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("room-app-launcher")).toHaveCount(0)
  })

  await test.step("desktop — recents survive a real page reload in the same tab", async () => {
    // The regression this proves is a real browser lifecycle, not a helper
    // round-trip: the reloaded Room must still know what this tab opened.
    const beforeReload = await page.evaluate(() =>
      window.sessionStorage.getItem(
        `free4chat:room-app-recents:v1:${new URLSearchParams(
          window.location.search
        ).get("id")}`
      )
    )
    expect(beforeReload).toContain(FIXTURE_ROOM_APP_ID)

    // A reload is the ordinary "reopen the same Room in this tab" path: the
    // nickname is already remembered, so the Room mounts directly.
    await page.reload()
    await expect(page.getByTestId("room-stage")).toBeVisible()
    await expect(page.getByTestId("stage-apps-launcher")).toBeVisible()
    const afterReload = await page.evaluate(() =>
      window.sessionStorage.getItem(
        `free4chat:room-app-recents:v1:${new URLSearchParams(
          window.location.search
        ).get("id")}`
      )
    )
    expect(afterReload).toBe(beforeReload)
    await page.getByTestId("stage-apps-launcher").click()
    await expect(page.getByTestId("room-app-launcher-recent")).toBeVisible()
    await expect(
      page.getByTestId(`launcher-app-${FIXTURE_ROOM_APP_ID}`)
    ).toBeVisible()
    await page.screenshot({
      path: `${ARTIFACT_DIR}/10-desktop-recents-after-reload.png`,
      fullPage: false,
    })
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("room-app-launcher")).toHaveCount(0)
  })

  await test.step("phone 390x844 — compact Room + Apps surface", async () => {
    const phone = await page.context().newPage()
    await phone.setViewportSize({ width: 390, height: 844 })
    await joinRoom(phone, `${slug}-phone`)
    await expect(phone.getByTestId("stage-apps-launcher")).toBeVisible()
    await phone.screenshot({
      path: `${ARTIFACT_DIR}/07-phone-room.png`,
      fullPage: false,
    })
    await phone.getByTestId("stage-apps-launcher").click()
    await expect(phone.getByTestId("room-app-launcher")).toBeVisible()
    await expect(
      phone.getByTestId("launcher-app-fixture-fifth-app")
    ).toBeVisible()
    await phone.screenshot({
      path: `${ARTIFACT_DIR}/08-phone-launcher.png`,
      fullPage: false,
    })
    const layout = await reportLayout(phone, "phone-launcher")
    expect(layout.launcher).not.toBeNull()
    expect(layout.launcher!.x).toBeGreaterThanOrEqual(0)
    expect(layout.launcher!.x + layout.launcher!.w).toBeLessThanOrEqual(390)
    expect(layout.launcher!.y + layout.launcher!.h).toBeLessThanOrEqual(844)
    expect(layout.pageOverflow).toBeLessThanOrEqual(0)
    await phone.getByTestId("room-app-search").fill("fifth")
    await phone.getByTestId("room-app-search").press("Enter")
    await expect(phone.getByTestId("room-app-iframe")).toBeVisible()
    await phone.screenshot({
      path: `${ARTIFACT_DIR}/09-phone-app-open.png`,
      fullPage: false,
    })

    // Open two more Apps: a phone must still show exactly ONE App shortcut
    // next to `Apps…`, never [current][recent][Apps…].
    for (const appId of ["fixture-second-app", "fixture-third-app"] as const) {
      await phone.getByTestId("stage-apps-launcher").click()
      await phone.getByTestId(`launcher-app-${appId}`).click()
      // Earlier Apps stay resident (hidden) in their own slots, so the visible
      // iframe must be located through this App's slot.
      await expect(
        phone.locator(`[data-testid="room-app-slot-${appId}"] iframe`)
      ).toBeVisible()
    }
    const phoneLayout = await reportLayout(phone, "phone-three-apps-open")
    expect(phoneLayout.strip!.rows).toBe(1)
    expect(phoneLayout.inlineChips).toHaveLength(1)
    expect(phoneLayout.inlineChips[0]).toBe("stage-app-fixture-third-app")
    expect(phoneLayout.pageOverflow).toBeLessThanOrEqual(0)
    await phone.screenshot({
      path: `${ARTIFACT_DIR}/11-phone-one-shortcut.png`,
      fullPage: false,
    })
    await expect
      .poll(() =>
        phone.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }))
      )
      .toEqual({ scrollWidth: 390, clientWidth: 390 })
    await phone.close()
  })
})
