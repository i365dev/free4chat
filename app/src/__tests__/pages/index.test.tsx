import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import Home from "../../pages/index"

describe("Home page", () => {
  it("renders real product content immediately, with no Turnstile challenge blocking the view", () => {
    render(<Home />)

    const heroHeading = screen.getByRole("heading", {
      name: /open a room\. bring people and agents together\./i,
    })
    expect(heroHeading).toBeInTheDocument()
    const pageContent = heroHeading.closest("main")?.firstElementChild
    expect(pageContent).not.toHaveClass("overflow-y-auto")
    const signalText = heroHeading.querySelector(".signal-collapse-text")
    expect(signalText).toHaveClass("signal-collapse-text", "psy-headline")
    expect(heroHeading).not.toHaveClass("psy-headline")
    expect(
      screen.getByText("FREE4CHAT://RELAY — LINK READY")
    ).toBeInTheDocument()
    const joinButton = screen.getByRole("button", {
      name: "Warp In — Join Room",
    })
    expect(joinButton).toBeInTheDocument()
    expect(joinButton).toHaveTextContent("WARP IN →")
    expect(screen.getByPlaceholderText("room_name")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("nickname")).toBeInTheDocument()
    expect(
      screen.getByRole("link", {
        name: "Create and join Rooms from the terminal →",
      })
    ).toHaveAttribute("href", "/docs/getting-started/agent-room")
    expect(
      screen.getByText("$ free4chat-agent room create --agent pi --name Pi")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Agent Runtime: macOS + Linux. Human supervision: supported browsers, including Windows and mobile."
      )
    ).toBeInTheDocument()

    expect(
      screen.getByText(
        "A bounded sandboxed mini-app with Room-shared state and explicit access to the originating Runtime's bounded local capabilities."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", {
        name: "Bring a local capability into the Room without moving it to the cloud.",
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "A Runtime can project a bounded semantic capability from an external Adapter. A Generated Task App can use it on an explicit Human action while local endpoints and credentials stay local."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", {
        name: "How interactive Task outputs work →",
      })
    ).toHaveAttribute("href", "/docs/guides/interactive-task-outputs")
    expect(
      screen.getByText("// when_you_need_another_agent")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("// when_you_need_another_capability")
    ).not.toBeInTheDocument()

    // The homepage explore slots answer "what can I do with Free4Chat?" and
    // route to the product pages; docs and API entry points stay in the
    // footer, and the Agent quick start owns the developer card above.
    expect(
      screen.getByRole("link", { name: "Temporary Rooms →" })
    ).toHaveAttribute("href", "/temporary-chat-room")
    expect(
      screen.getByRole("link", { name: "AI Agent Rooms →" })
    ).toHaveAttribute("href", "/ai-agent-room")
    expect(
      screen.getByRole("link", { name: "Multi-Agent Collaboration →" })
    ).toHaveAttribute("href", "/multi-agent-collaboration")
    expect(screen.getByRole("link", { name: "Room Apps →" })).toHaveAttribute(
      "href",
      "/apps"
    )
    expect(
      screen.getByRole("link", { name: "Explore use cases →" })
    ).toHaveAttribute("href", "/use-cases")
    expect(
      screen.getByRole("link", { name: "Documentation →" })
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

  it("prefills separate cosmic defaults and keeps both dice controls wired", async () => {
    render(<Home />)

    await waitFor(() => {
      const room = screen.getByLabelText("Room") as HTMLInputElement
      const nickname = screen.getByLabelText("Nickname") as HTMLInputElement
      expect(room.value).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]+$/)
      expect(nickname.value).toMatch(/^[A-Z][a-z]+$/)
    })

    fireEvent.click(screen.getByTitle("Randomize room name"))
    fireEvent.click(screen.getByTitle("Randomize nickname"))
    expect((screen.getByLabelText("Room") as HTMLInputElement).value).toMatch(
      /^[a-z]+-[a-z]+-[a-z0-9]+$/
    )
    expect(
      (screen.getByLabelText("Nickname") as HTMLInputElement).value
    ).toMatch(/^[A-Z][a-z]+$/)
  })
})
