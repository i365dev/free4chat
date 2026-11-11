import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import Home from "../../pages/index"

describe("Home page", () => {
  it("renders real product content immediately, with no Turnstile challenge blocking the view", () => {
    render(<Home />)

    const heroHeading = screen.getByRole("heading", {
      name: "开启临时房间，让人与 Agent 在此相聚。",
    })
    expect(heroHeading).toBeInTheDocument()
    const pageContent = heroHeading.closest("main")?.firstElementChild
    expect(pageContent).not.toHaveClass("overflow-y-auto")
    const signalText = heroHeading.querySelector(".signal-collapse-text")
    expect(signalText).toHaveClass("signal-collapse-text", "psy-headline")
    expect(heroHeading).not.toHaveClass("psy-headline")
    expect(
      screen.getByText("FREE4CHAT://中继 — 链路就绪")
    ).toBeInTheDocument()
    const joinButton = screen.getByRole("button", {
      name: "进入房间",
    })
    expect(joinButton).toBeInTheDocument()
    expect(joinButton).toHaveTextContent("进入房间 →")
    expect(screen.getByPlaceholderText("输入房间名称")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("输入你的昵称")).toBeInTheDocument()
    expect(
      screen.getByRole("link", {
        name: "通过终端创建并加入房间 →",
      })
    ).toHaveAttribute("href", "/docs/getting-started/agent-room")
    expect(
      screen.getByText("$ free4chat-agent room create --agent pi --name Pi")
    ).toBeInTheDocument()
    expect(document.body).toHaveTextContent(/Agent Runtime 支持 macOS 和 Linux/)
    expect(document.body).toHaveTextContent(/Windows 和移动设备/)

    expect(
      screen.getByText(
        "受限沙箱中的小型应用，可共享房间状态，并在明确授权后使用发起任务的 Runtime 本地能力。"
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", {
        name: "将本地能力带入房间，无需迁移到云端。",
      })
    ).toBeInTheDocument()
    expect(document.body).toHaveTextContent(
      /Runtime 可通过外部 Adapter 提供受限的语义能力/
    )
    expect(document.body).toHaveTextContent(/本地端点和凭据始终留在本机/)
    expect(
      screen.getByRole("link", {
        name: "了解交互式任务产出 →",
      })
    ).toHaveAttribute("href", "/docs/guides/interactive-task-outputs")
    expect(
      screen.getByText("// 需要更多 Agent 时")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("// when_you_need_another_capability")
    ).not.toBeInTheDocument()

    // The homepage explore slots answer "what can I do with Free4Chat?" and
    // route to the product pages; docs and API entry points stay in the
    // footer, and the Agent quick start owns the developer card above.
    expect(
      screen.getByRole("link", { name: "临时房间 →" })
    ).toHaveAttribute("href", "/temporary-chat-room")
    expect(
      screen.getByRole("link", { name: "AI Agent 房间 →" })
    ).toHaveAttribute("href", "/ai-agent-room")
    expect(
      screen.getByRole("link", { name: "多 Agent 协作 →" })
    ).toHaveAttribute("href", "/multi-agent-collaboration")
    expect(screen.getByRole("link", { name: "房间应用 →" })).toHaveAttribute(
      "href",
      "/apps"
    )
    expect(
      screen.getByRole("link", { name: "浏览使用场景 →" })
    ).toHaveAttribute("href", "/use-cases")
    expect(
      screen.getByRole("link", { name: "文档 →" })
    ).toHaveAttribute("href", "/docs")

    // The stale immediate-expiry wording must not come back.
    expect(
      screen.queryByText(/once everyone has left/i)
    ).not.toBeInTheDocument()

    // The old global gate rendered this instead of the page. It must be gone.
    expect(
      screen.queryByText(/verifying you.re human/i)
    ).not.toBeInTheDocument()
  })

  it("leaves names blank by default and keeps both dice controls wired", async () => {
    render(<Home />)

    const room = screen.getByLabelText("房间名称") as HTMLInputElement
    const nickname = screen.getByLabelText("昵称") as HTMLInputElement
    expect(room.value).toBe("")
    expect(nickname.value).toBe("")

    fireEvent.click(screen.getByTitle("随机生成房间名称"))
    fireEvent.click(screen.getByTitle("随机生成昵称"))
    expect((screen.getByLabelText("房间名称") as HTMLInputElement).value).toMatch(
      /^[a-z]+-[a-z]+-[a-z0-9]+$/
    )
    expect(
      (screen.getByLabelText("昵称") as HTMLInputElement).value
    ).toMatch(/^[A-Z][a-z]+$/)
  })
})
