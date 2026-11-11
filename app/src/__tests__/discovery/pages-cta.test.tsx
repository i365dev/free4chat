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
    "$name renders a working room CTA back to the room product",
    ({ Component }) => {
      const { unmount } = render(<Component />)
      const cta = screen.getByRole("link", { name: "开启房间" })
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
      screen.getByRole("link", { name: "开启房间" }).click()

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
      label: "阅读 MCP 文档",
      page: "ai-agent-room",
      target: "mcp-docs",
    },
    {
      Component: MultiAgentCollaborationPage,
      label: "邀请你的 Agent",
      page: "multi-agent-collaboration",
      target: "bring-agent",
    },
    {
      Component: AgentTasksPage,
      label: "阅读 Agent 任务指南",
      page: "agent-tasks",
      target: "docs",
    },
    {
      Component: RemoteAgentPage,
      label: "阅读 Agent 房间快速入门",
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
      screen.getByRole("navigation", { name: "了解更多" })
    ).toContainElement(screen.getByRole("link", { name: "房间应用" }))
    expect(screen.getByRole("link", { name: "房间应用" })).toHaveAttribute(
      "href",
      "/apps"
    )
  })

  it("includes the new scenario pages in the shared discovery footer", () => {
    render(<DiscoveryFooter />)

    expect(screen.getByRole("link", { name: "使用场景" })).toHaveAttribute(
      "href",
      "/use-cases"
    )
    expect(screen.getByRole("link", { name: "远程监督 Agent" })).toHaveAttribute(
      "href",
      "/remote-agent"
    )
  })

  it("includes the Project privacy and community links", () => {
    render(<DiscoveryFooter />)

    expect(screen.getByRole("link", { name: "隐私说明" })).toHaveAttribute(
      "href",
      "/privacy"
    )
    expect(screen.getByRole("link", { name: "讨论区" })).toHaveAttribute(
      "href",
      "https://github.com/i365dev/free4chat/discussions"
    )
    expect(screen.getByRole("link", { name: "报告问题" })).toHaveAttribute(
      "href",
      "https://github.com/i365dev/free4chat/issues"
    )
    expect(screen.getByRole("link", { name: "联系我们" })).toHaveAttribute(
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
        name: "了解跨设备监督",
      })
    ).toHaveAttribute("href", "/remote-agent")
    const agentTaskLinks = screen.getAllByRole("link", {
      name: "了解 Agent 任务",
    })
    expect(agentTaskLinks).toHaveLength(2)
    for (const link of agentTaskLinks) {
      expect(link).toHaveAttribute("href", "/agent-tasks")
    }
    expect(
      screen.getByRole("link", { name: "探索多 Agent 协作" })
    ).toHaveAttribute("href", "/multi-agent-collaboration")
    expect(
      screen.getByRole("link", { name: "了解 AI Agent 房间" })
    ).toHaveAttribute("href", "/ai-agent-room")
    expect(
      screen.getByRole("link", { name: "浏览房间应用" })
    ).toHaveAttribute("href", "/apps")
    expect(
      screen.getByRole("link", {
        name: "邀请自己的 Agent 使用共享白板",
      })
    ).toHaveAttribute("href", "/apps/ai-whiteboard")
    expect(
      screen.getByRole("link", { name: "Agent 如何参与房间应用" })
    ).toHaveAttribute("href", "/docs/concepts/agent-room-app-participation")
    expect(
      screen.getByRole("link", { name: "免费协作白板" })
    ).toHaveAttribute("href", "/apps/whiteboard")
    expect(
      screen.getByRole("link", { name: "交互式任务产出" })
    ).toHaveAttribute("href", "/docs/guides/interactive-task-outputs")
    expect(
      screen.getByRole("link", { name: "浏览房间应用目录" })
    ).toHaveAttribute("href", "/apps")
  })

  it("links Agent Rooms to the bounded shared-artifact example and generic concept", () => {
    render(<AiAgentRoomPage />)

    expect(
      screen.getByRole("link", {
        name: "了解 Agent 如何使用共享白板",
      })
    ).toHaveAttribute("href", "/apps/ai-whiteboard")
    expect(
      screen.getByRole("link", {
        name: "阅读房间应用协作机制",
      })
    ).toHaveAttribute("href", "/docs/concepts/agent-room-app-participation")
  })

  it("links remote supervision to Tasks and both Agent Runtime references", () => {
    render(<RemoteAgentPage />)

    screen
      .getAllByRole("link", { name: "Agent 任务" })
      .forEach((link) => expect(link).toHaveAttribute("href", "/agent-tasks"))
    expect(
      screen.getByRole("link", { name: "Agent 房间快速入门" })
    ).toHaveAttribute("href", "/docs/getting-started/agent-room")
    expect(
      screen.getByRole("link", { name: "Runtime 与 Harness" })
    ).toHaveAttribute("href", "/docs/concepts/runtime-harness")
  })
})
