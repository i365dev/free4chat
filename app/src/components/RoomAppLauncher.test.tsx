import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RoomAppLauncher, { ROOM_APP_DISCOVERY_URL } from "./RoomAppLauncher"
import type { RoomAppDefinition } from "../common/roomApp"

/**
 * #98: the launcher is the surface that has to scale, so these tests hold the
 * product line directly — every promoted runtime reachable, fast text search,
 * one-action open, truthful current-App state, keyboard usable, and no
 * favorites/accounts/ranking machinery smuggled in behind the UI.
 */

const CATALOG: RoomAppDefinition[] = [
  ["whiteboard", "Whiteboard"],
  ["typing-race", "Typing"],
  ["draw-and-guess", "Draw & Guess"],
  ["pomodoro", "Pomodoro"],
  ["bingo", "Bingo"],
  ["planning-poker", "Planning Poker"],
  ["random-wheel", "Random Wheel"],
  ["meeting-timer", "Meeting Timer"],
  ["shared-pad", "Shared Pad"],
  ["live-qa", "Live Q&A"],
  ["retro", "Retrospective"],
  ["undercover", "Undercover"],
  ["tier-list", "Tier List"],
  ["bracket", "Bracket"],
  ["buzzer", "Quiz Buzzer"],
  ["random-teams", "Random Teams"],
  ["live-poll", "Live Poll"],
  ["arena-shooter", "Arena Shooter"],
].map(([id, label]) => ({
  id,
  label,
  url: `https://room-apps.free4.chat/${id}`,
  origin: "https://room-apps.free4.chat",
}))

function renderLauncher({
  apps = CATALOG,
  recentAppIds = [] as string[],
  activeAppId = null as string | null,
  isDesktop = true,
} = {}) {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  const anchorRef = { current: null }
  const view = render(
    <RoomAppLauncher
      apps={apps}
      recentAppIds={recentAppIds}
      activeAppId={activeAppId}
      onSelect={onSelect}
      onClose={onClose}
      isDesktop={isDesktop}
      anchorRef={anchorRef}
    />
  )
  return { onSelect, onClose, anchorRef, ...view }
}

const optionIds = () =>
  screen
    .getAllByRole("menuitem")
    .map((option) =>
      option.getAttribute("data-testid")!.replace("launcher-app-", "")
    )

describe("RoomAppLauncher", () => {
  beforeEach(() => {
    // jsdom reports a 1024x768 window; the desktop path is what CI exercises.
    window.innerWidth = 1280
    window.innerHeight = 800
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps a whole 18-App catalog reachable and labelled from the catalog", () => {
    renderLauncher()
    expect(optionIds()).toHaveLength(CATALOG.length)
    for (const app of CATALOG)
      expect(
        screen.getByTestId(`launcher-app-${app.id}`).textContent
      ).toContain(app.label)
  })

  it("searches by label and by id, case-insensitively", () => {
    renderLauncher()
    const search = screen.getByTestId("room-app-search")

    fireEvent.change(search, { target: { value: "poker" } })
    expect(optionIds()).toEqual(["planning-poker"])

    fireEvent.change(search, { target: { value: "LIVE" } })
    expect(optionIds()).toEqual(["live-qa", "live-poll"])

    fireEvent.change(search, { target: { value: "  retro  " } })
    expect(optionIds()).toEqual(["retro"])

    fireEvent.change(search, { target: { value: "random-" } })
    expect(optionIds()).toEqual(["random-wheel", "random-teams"])
  })

  it("shows a bounded recent section for this Room without hiding the catalog", () => {
    renderLauncher({
      recentAppIds: ["whiteboard", "live-poll"],
      activeAppId: "live-poll",
    })
    const recent = within(screen.getByTestId("room-app-launcher-recent"))
    expect(recent.getByTestId("launcher-app-live-poll")).toBeInTheDocument()
    expect(recent.getByTestId("launcher-app-whiteboard")).toBeInTheDocument()
    // Recent Apps are not duplicated in "All apps".
    expect(optionIds()).toHaveLength(CATALOG.length)
    expect(
      within(screen.getByTestId("room-app-launcher-all")).queryByTestId(
        "launcher-app-whiteboard"
      )
    ).toBeNull()
  })

  it("marks the current App and opens a selected App in one action", () => {
    const { onSelect } = renderLauncher({
      recentAppIds: ["whiteboard"],
      activeAppId: "whiteboard",
    })
    const current = screen.getByTestId("launcher-app-whiteboard")
    expect(current).toHaveAttribute("aria-current", "true")
    expect(current.textContent).toContain("Current")

    fireEvent.click(screen.getByTestId("launcher-app-bingo"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("bingo")
  })

  it("shows an empty state instead of an empty list when nothing matches", () => {
    renderLauncher()
    fireEvent.change(screen.getByTestId("room-app-search"), {
      target: { value: "definitely-not-an-app" },
    })
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(screen.getByTestId("room-app-search-empty").textContent).toContain(
      "definitely-not-an-app"
    )
    // Clearing the query restores the catalog.
    fireEvent.change(screen.getByTestId("room-app-search"), {
      target: { value: "" },
    })
    expect(optionIds()).toHaveLength(CATALOG.length)
  })

  it("is fully keyboard operable: focus, arrow, Enter, Escape", () => {
    const { onSelect, onClose } = renderLauncher({
      recentAppIds: ["whiteboard"],
      activeAppId: "whiteboard",
    })
    const search = screen.getByTestId("room-app-search")
    // Opening the launcher puts focus in the search box.
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: "ArrowDown" })
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      "room-app-option-typing-race"
    )
    fireEvent.keyDown(search, { key: "ArrowUp" })
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      "room-app-option-whiteboard"
    )

    fireEvent.keyDown(search, { key: "End" })
    const lastOptionId = screen
      .getAllByRole("menuitem")
      [screen.getAllByRole("menuitem").length - 1].getAttribute("id")!
    expect(search).toHaveAttribute("aria-activedescendant", lastOptionId)

    fireEvent.change(search, { target: { value: "bingo" } })
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onSelect).toHaveBeenCalledWith("bingo")

    fireEvent.keyDown(search, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on an outside pointer press but not on an inside one", () => {
    const { onClose } = renderLauncher()
    fireEvent.mouseDown(screen.getByTestId("room-app-search"))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders long catalog labels without a fixed-width or nowrap assumption", () => {
    const longLabel = `Long ${"App ".repeat(15)}Name`
    renderLauncher({
      apps: [
        {
          id: "long-label",
          label: longLabel,
          url: "https://room-apps.free4.chat/long-label",
          origin: "https://room-apps.free4.chat",
        },
      ],
    })
    const option = screen.getByTestId("launcher-app-long-label")
    // The label is rendered in full (no client truncation) inside a wrapping,
    // shrinkable box: the layout, not the data, absorbs long labels.
    expect(option.textContent).toBe(longLabel)
    const labelBox = within(option).getByText(longLabel)
    expect(labelBox.className).toContain("min-w-0")
    expect(labelBox.className).toContain("break-words")
  })

  it("links to App discovery only as an explicit click target", () => {
    renderLauncher()
    const link = screen.getByRole("link", { name: /Explore all apps/ })
    expect(link).toHaveAttribute("href", ROOM_APP_DISCOVERY_URL)
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("stays inside the viewport on a ~390px phone", () => {
    window.innerWidth = 390
    window.innerHeight = 844
    renderLauncher({ isDesktop: false })
    const launcher = screen.getByTestId("room-app-launcher")
    const style = launcher.getAttribute("style") ?? ""
    expect(style).toContain("left: 8px")
    expect(style).toContain("width: 374px")
    // Every promoted App is still reachable on the narrow surface.
    expect(optionIds()).toHaveLength(CATALOG.length)
  })

  it("carries no favorites, accounts or ranking surface", () => {
    renderLauncher({ recentAppIds: ["whiteboard"], activeAppId: "whiteboard" })
    const text = screen.getByTestId("room-app-launcher").textContent ?? ""
    // Word-boundary matching keeps "Planning Poker" from reading as a "pin".
    expect(text).not.toMatch(
      /\b(favorites?|favourites?|unpin|account|profile|sign in|sign up)\b/i
    )
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(
      screen.queryByRole("button", { name: /\b(pin|unpin|favorite)\b/i })
    ).toBeNull()
    // No account/preference surface is rendered even though the launcher knows
    // which Apps this browser opened.
    expect(screen.queryByRole("textbox", { name: /name|email/i })).toBeNull()
    // Ordering is recency then catalog order — never a computed score.
    expect(optionIds().slice(0, 2)).toEqual(["whiteboard", "typing-race"])
  })
})
