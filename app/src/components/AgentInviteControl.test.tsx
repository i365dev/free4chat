import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { trackAnalyticsEvent } from "@common/utils"

import AgentInviteControl from "./AgentInviteControl"

// #236 follow-up: AgentInviteCopied must keep EXACTLY its long-lived meaning
// — one event per ACTUAL successful clipboard write. Opening, viewing or
// closing the popover, and clipboard failures emit zero.
vi.mock("@common/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@common/utils")>()
  return { ...actual, trackAnalyticsEvent: vi.fn() }
})

const INVITE_PROMPT = "Join my temporary Free4Chat room as an Agent.\n\nRoom: …"

function renderControl(open = false, onOpenChange = vi.fn()) {
  return render(
    <AgentInviteControl
      roomType="audio"
      invitePrompt={INVITE_PROMPT}
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}

function installClipboard(resolve: boolean) {
  const writeText = resolve
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(new Error("blocked"))
  Object.assign(navigator, { clipboard: { writeText } })
  return writeText
}

function promptPreview(): HTMLElement {
  const element = screen
    .getAllByText((_content, node) => node?.tagName === "PRE")
    .find((node) => node.textContent === INVITE_PROMPT)
  if (!element) throw new Error("invite prompt preview not found")
  return element
}

beforeEach(() => {
  vi.mocked(trackAnalyticsEvent).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AgentInviteControl (#236 follow-up)", () => {
  it("opens via the header button without copying anything", () => {
    installClipboard(true)
    const onOpenChange = vi.fn()
    renderControl(false, onOpenChange)
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.queryByText("Invite an Agent")).not.toBeInTheDocument()
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
    )
  })

  it("shows the actual invite prompt read-only and the explicit copy action", () => {
    installClipboard(true)
    renderControl(true)
    expect(screen.getByText("Invite an Agent")).toBeInTheDocument()
    expect(screen.getByText(/Bring an Agent you're already using/)).toBeTruthy()
    expect(
      screen.getByText(
        /The Agent will set up Free4Chat locally if needed and join this Room itself/
      )
    ).toBeTruthy()
    expect(promptPreview()).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Copy invite prompt" })
    ).toBeTruthy()
    // The header button never mutates into "Copied!".
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
  })

  it("emits exactly one AgentInviteCopied only after a successful copy", async () => {
    const writeText = installClipboard(true)
    renderControl(true)

    // Opening/viewing the popover emitted nothing.
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy invite prompt" }))
    expect(writeText).toHaveBeenCalledWith(INVITE_PROMPT)
    expect(
      await screen.findByText(
        /✓ Invite prompt copied\. Paste it into your Agent\./
      )
    ).toBeInTheDocument()
    // Exactly one AgentInviteCopied, only after the clipboard write settled.
    await waitFor(() => expect(trackAnalyticsEvent).toHaveBeenCalledTimes(1))
    expect(trackAnalyticsEvent).toHaveBeenCalledWith("AgentInviteCopied", {
      surface: "room",
      roomType: "audio",
    })
    // Header button and primary action stay stable.
    expect(
      screen.getByRole("button", { name: "Copy invite prompt" })
    ).toBeTruthy()
    expect(screen.queryByText("Copied!")).not.toBeInTheDocument()
  })

  it("emits zero AgentInviteCopied on clipboard failure and shows in-popover feedback", async () => {
    installClipboard(false)
    renderControl(true)
    fireEvent.click(screen.getByRole("button", { name: "Copy invite prompt" }))
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
    )
    expect(
      await screen.findByText("Clipboard access was blocked. Try again.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Copy invite prompt" })
    ).toBeEnabled()
  })

  it("emits one additional AgentInviteCopied per successful re-copy", async () => {
    installClipboard(true)
    renderControl(true)
    const copy = screen.getByRole("button", { name: "Copy invite prompt" })
    fireEvent.click(copy)
    fireEvent.click(copy)
    await waitFor(() => expect(trackAnalyticsEvent).toHaveBeenCalledTimes(2))
    expect(trackAnalyticsEvent).toHaveBeenCalledWith("AgentInviteCopied", {
      surface: "room",
      roomType: "audio",
    })
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0)
  })

  it("closes on Escape and outside clicks", () => {
    const onOpenChange = vi.fn()
    renderControl(true, onOpenChange)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    onOpenChange.mockClear()
    renderControl(true, onOpenChange)
    fireEvent.mouseDown(document.body)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
