import type { ReactElement } from "react"

import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import DiscoveryFooter from "../../components/DiscoveryFooter"
import AgentTasksPage from "../../pages/agent-tasks"
import AiAgentRoomPage from "../../pages/ai-agent-room"
import MultiAgentCollaborationPage from "../../pages/multi-agent-collaboration"
import PrivacyPage from "../../pages/privacy"
import RemoteAgentPage from "../../pages/remote-agent"
import TemporaryChatRoomPage from "../../pages/temporary-chat-room"
import UseCasesPage from "../../pages/use-cases"

const PAGES: Array<{ name: string; Component: () => ReactElement }> = [
  { name: "use-cases", Component: UseCasesPage },
  { name: "remote-agent", Component: RemoteAgentPage },
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
    {
      Component: AgentTasksPage,
      label: "Read the Agent Tasks guide",
      page: "agent-tasks",
      target: "docs",
    },
    {
      Component: RemoteAgentPage,
      label: "Read the Agent Room quick start",
      page: "remote-agent",
      target: "docs",
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

describe("Room Apps discovery link", () => {
  it("includes Room Apps in the shared discovery footer", () => {
    render(<DiscoveryFooter />)

    expect(
      screen.getByRole("navigation", { name: "Learn more" })
    ).toContainElement(screen.getByRole("link", { name: "Room Apps" }))
    expect(screen.getByRole("link", { name: "Room Apps" })).toHaveAttribute(
      "href",
      "/apps"
    )
  })

  it("includes the new scenario pages in the shared discovery footer", () => {
    render(<DiscoveryFooter />)

    expect(screen.getByRole("link", { name: "Use cases" })).toHaveAttribute(
      "href",
      "/use-cases"
    )
    expect(screen.getByRole("link", { name: "Remote Agent" })).toHaveAttribute(
      "href",
      "/remote-agent"
    )
  })

  it("includes the Project privacy and community links", () => {
    render(<DiscoveryFooter />)

    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy"
    )
    expect(screen.getByRole("link", { name: "Discussions" })).toHaveAttribute(
      "href",
      "https://github.com/i365dev/free4chat/discussions"
    )
    expect(screen.getByRole("link", { name: "Report a bug" })).toHaveAttribute(
      "href",
      "https://github.com/i365dev/free4chat/issues"
    )
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute(
      "href",
      "mailto:hello@free4.chat"
    )
  })
})

describe("Use cases discovery links", () => {
  it("connects each scenario to its canonical product or documentation page", () => {
    render(<UseCasesPage />)

    expect(
      screen.getByRole("link", {
        name: "See how cross-device supervision works",
      })
    ).toHaveAttribute("href", "/remote-agent")
    expect(
      screen.getByRole("link", { name: "Learn about Agent Tasks" })
    ).toHaveAttribute("href", "/agent-tasks")
    expect(
      screen.getByRole("link", { name: "Explore multi-Agent collaboration" })
    ).toHaveAttribute("href", "/multi-agent-collaboration")
    expect(
      screen.getByRole("link", { name: "How AI Agent Rooms work" })
    ).toHaveAttribute("href", "/ai-agent-room")
    expect(
      screen.getByRole("link", { name: "Browse Room Apps" })
    ).toHaveAttribute("href", "/apps")
    expect(
      screen.getByRole("link", { name: "Agent participation in Room Apps" })
    ).toHaveAttribute("href", "/docs/concepts/agent-room-app-participation")
    expect(
      screen.getByRole("link", { name: "Interactive Task outputs" })
    ).toHaveAttribute("href", "/docs/guides/interactive-task-outputs")
    expect(
      screen.getByRole("link", { name: "Explore the Room App catalog" })
    ).toHaveAttribute("href", "/apps")
  })

  it("links remote supervision to Tasks and both Agent Runtime references", () => {
    render(<RemoteAgentPage />)

    screen
      .getAllByRole("link", { name: "Agent Tasks" })
      .forEach((link) => expect(link).toHaveAttribute("href", "/agent-tasks"))
    expect(
      screen.getByRole("link", { name: "Agent Room quick start" })
    ).toHaveAttribute("href", "/docs/getting-started/agent-room")
    expect(
      screen.getByRole("link", { name: "Runtime and Harness" })
    ).toHaveAttribute("href", "/docs/concepts/runtime-harness")
  })
})
