import type { ReactElement } from "react"

import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import AiAgentRoomPage from "../../pages/ai-agent-room"
import MultiAgentCollaborationPage from "../../pages/multi-agent-collaboration"
import PrivacyPage from "../../pages/privacy"
import TemporaryChatRoomPage from "../../pages/temporary-chat-room"

const PAGES: Array<{ name: string; Component: () => ReactElement }> = [
  { name: "temporary-chat-room", Component: TemporaryChatRoomPage },
  { name: "ai-agent-room", Component: AiAgentRoomPage },
  { name: "multi-agent-collaboration", Component: MultiAgentCollaborationPage },
  { name: "privacy", Component: PrivacyPage },
]

describe("Discovery pages — CTA", () => {
  it.each(PAGES)(
    "$name renders a working 'Open a room' CTA back to the room product",
    ({ Component }) => {
      const { unmount } = render(<Component />)
      const cta = screen.getByRole("link", { name: "Open a room" })
      expect(cta).toHaveAttribute("href", "/")
      unmount()
    }
  )
})

describe("Discovery pages — CTA analytics", () => {
  beforeEach(() => {
    ;(window as unknown as { umami?: unknown }).umami = {
      track: vi.fn(),
    }
  })

  it.each(PAGES)(
    "$name's CTA click sends only a bounded page identifier, never room/user data",
    ({ Component }) => {
      const track = (
        window as unknown as { umami: { track: ReturnType<typeof vi.fn> } }
      ).umami.track
      const { unmount } = render(<Component />)
      screen.getByRole("link", { name: "Open a room" }).click()

      expect(track).toHaveBeenCalledTimes(1)
      const [eventName, eventData] = track.mock.calls[0]
      expect(eventName).toBe("DiscoveryCtaClicked")
      expect(Object.keys(eventData as object)).toEqual(["page"])
      expect(typeof (eventData as { page: unknown }).page).toBe("string")
      unmount()
    }
  )

  it.each([
    {
      Component: AiAgentRoomPage,
      label: "Read the MCP docs",
      page: "ai-agent-room",
      target: "mcp-docs",
    },
    {
      Component: MultiAgentCollaborationPage,
      label: "Bring your Agent",
      page: "multi-agent-collaboration",
      target: "bring-agent",
    },
  ])(
    "tracks a secondary discovery CTA with bounded page and target buckets",
    ({ Component, label, page, target }) => {
      const track = (
        window as unknown as { umami: { track: ReturnType<typeof vi.fn> } }
      ).umami.track
      const { unmount } = render(<Component />)
      screen.getByRole("link", { name: label }).click()

      expect(track).toHaveBeenCalledTimes(1)
      const [eventName, eventData] = track.mock.calls[0]
      expect(eventName).toBe("DiscoverySecondaryCtaClicked")
      expect(eventData).toEqual({ page, target })
      unmount()
    }
  )
})
