import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Message, UserInfo } from "@common/types"

import TextChatCard from "./TextChatCard"

function agentParticipant(): UserInfo {
  return {
    peerId: "agent-1",
    name: "Agent B",
    kind: "agent",
    room: "room",
  }
}

function renderCard(
  props: Partial<React.ComponentProps<typeof TextChatCard>> = {}
) {
  const onSendText = vi.fn()
  const onSendFile = vi.fn()
  const onSendAction = vi.fn()
  const view = render(
    <TextChatCard
      room="room"
      nickName="Human"
      messages={[]}
      participants={[agentParticipant()]}
      onSendText={onSendText}
      onSendFile={onSendFile}
      onSendAction={onSendAction}
      {...props}
    />
  )
  const composer = screen.getByLabelText(
    "Message the room or @ an Agent"
  ) as HTMLTextAreaElement
  return { view, onSendText, onSendFile, onSendAction, composer }
}

function typeMessage(composer: HTMLTextAreaElement, value: string) {
  // React 19's value tracker breaks fireEvent.change's own-property path on
  // controlled textareas; set through the prototype setter explicitly.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set
  setter!.call(composer, value)
  composer.dispatchEvent(new Event("input", { bubbles: true }))
  composer.selectionStart = value.length
  composer.selectionEnd = value.length
}

/** Simulate typing so the caret sits mid-text when React re-renders. */
function typeAtCaret(
  composer: HTMLTextAreaElement,
  value: string,
  caret: number
) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set
  setter!.call(composer, value)
  composer.selectionStart = caret
  composer.selectionEnd = caret
  composer.dispatchEvent(new Event("input", { bubbles: true }))
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("composer keyboard semantics", () => {
  it("sends on Enter with the trimmed text and clears the composer", () => {
    const { composer, onSendText } = renderCard()
    typeMessage(composer, "  hello room  ")
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).toHaveBeenCalledWith("hello room", [])
    expect(composer.value).toBe("")
  })

  it("does not send on Shift+Enter so newlines can be composed", () => {
    const { composer, onSendText } = renderCard()
    typeMessage(composer, "line one")
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true })
    expect(onSendText).not.toHaveBeenCalled()
    expect(composer.value).toBe("line one")
  })

  it("does not send empty or whitespace-only content on Enter", () => {
    const { composer, onSendText } = renderCard()
    typeMessage(composer, "   ")
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).not.toHaveBeenCalled()
  })

  it("does not send while an IME composition is in progress", () => {
    const { composer, onSendText } = renderCard()
    typeMessage(composer, "ni hao")
    fireEvent.compositionStart(composer)
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).not.toHaveBeenCalled()
    fireEvent.compositionEnd(composer)
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).toHaveBeenCalledWith("ni hao", [])
  })

  it("keeps Enter as a newline on coarse pointers and sends via the button", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }))
    const { composer, onSendText } = renderCard()
    typeMessage(composer, "from mobile")
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText("Send message"))
    expect(onSendText).toHaveBeenCalledWith("from mobile", [])
  })

  it("resolves @Agent targets from the textarea picker at the caret", async () => {
    const { composer, onSendText } = renderCard()
    // The mention is mid-text; the caret sits right after "@Age" as it would
    // while typing.
    typeAtCaret(composer, "@Age please review", 4)

    const option = await screen.findByText("Agent B")
    expect(option).toBeInTheDocument()

    // Arrow keys move the highlight; Enter picks the highlighted Agent.
    fireEvent.keyDown(composer, { key: "ArrowDown" })
    fireEvent.keyDown(composer, { key: "ArrowUp" })
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(composer.value).toContain("@Agent B "))
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).toHaveBeenCalledWith(
      expect.stringContaining("@Agent B"),
      ["agent-1"]
    )
  })

  it("dismisses the mention picker with Escape so Enter sends normally", () => {
    const { composer, onSendText } = renderCard()
    typeMessage(composer, "@Age")
    composer.selectionStart = 4
    composer.selectionEnd = 4

    fireEvent.keyDown(composer, { key: "Escape" })
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendText).toHaveBeenCalledWith("@Age", [])
  })

  it("keeps the / command picker working from the textarea", () => {
    const { composer, onSendAction } = renderCard()
    typeMessage(composer, "/")
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(onSendAction).toHaveBeenCalledWith(
      "whiteboard",
      expect.objectContaining({
        url: expect.stringContaining("excalidraw.com"),
      })
    )
  })
})

describe("markdown rendering", () => {
  function agentMarkdownMessage(text: string): Message {
    return {
      peerId: "agent-1",
      name: "Agent B",
      kind: "agent",
      type: "text",
      messageId: "m-1",
      sequence: 1,
      createdAt: Date.now(),
      text,
    }
  }

  it("renders GFM structure: headings, lists, tables, inline code, links", () => {
    renderCard({
      messages: [
        agentMarkdownMessage(
          [
            "## Review",
            "",
            "- one",
            "- two",
            "",
            "1. first",
            "",
            "| col | value |",
            "| --- | ----- |",
            "| a | b |",
            "",
            "Use `send_text` and see [docs](https://example.com/docs).",
          ].join("\n")
        ),
      ],
    })

    expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument()
    expect(screen.getByText("one").tagName).toBe("LI")
    expect(screen.getByText("first").tagName).toBe("LI")
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByText("send_text").tagName).toBe("CODE")
    const link = screen.getByRole("link", { name: "docs" })
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    expect(link).toHaveAttribute("href", "https://example.com/docs")
  })

  it("never executes raw HTML from Markdown", () => {
    const { view } = renderCard({
      messages: [
        agentMarkdownMessage(
          [
            "hello",
            "",
            "<script>window.__pwned = true</script>",
            "",
            '<img src=x onerror="window.__pwned = true" />',
            "",
            "![x](javascript:alert(1))",
          ].join("\n")
        ),
      ],
    })
    expect(view.container.querySelector("script")).toBeNull()
    expect(view.container.querySelector("img")).toBeNull()
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it("renders fenced code blocks with a language label and Copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderCard({
      messages: [agentMarkdownMessage("```ts\nconst foo = 1\n```")],
    })

    expect(screen.getByText("ts")).toBeInTheDocument()
    const pre = screen
      .getByRole("button", { name: "Copy code" })
      .closest("div")?.parentElement
    expect(pre?.querySelector("code")?.textContent).toBe("const foo = 1")

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const foo = 1"))
    expect(await screen.findByText("Copied!")).toBeInTheDocument()
  })

  it("keeps plain-line text messages readable without Markdown noise", () => {
    renderCard({
      messages: [agentMarkdownMessage("看一下这个？")],
    })
    expect(screen.getByText("看一下这个？")).toBeInTheDocument()
  })
})

describe("secondary action menu", () => {
  it("moves Whiteboard/Poll/Games/Attach into the + menu and keeps them wired", () => {
    const { onSendAction } = renderCard()

    // The legacy first-class pills are gone from the composer.
    expect(screen.queryByText("Draw")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("More actions"))
    expect(screen.getByText("Attach file")).toBeInTheDocument()
    expect(screen.getByText("Whiteboard")).toBeInTheDocument()
    expect(screen.getByText("Poll")).toBeInTheDocument()
    expect(screen.getByText("Games")).toBeInTheDocument()

    fireEvent.click(screen.getByText("Whiteboard"))
    expect(onSendAction).toHaveBeenCalledWith(
      "whiteboard",
      expect.objectContaining({
        url: expect.stringContaining("excalidraw.com"),
      })
    )
    expect(screen.queryByText("Attach file")).not.toBeInTheDocument()
  })

  it("opens the Games list from the + menu", () => {
    const { onSendAction } = renderCard()
    fireEvent.click(screen.getByLabelText("More actions"))
    fireEvent.click(screen.getByText("Games"))
    fireEvent.click(screen.getByText("skribbl.io"))
    expect(onSendAction).toHaveBeenCalledWith(
      "game",
      expect.objectContaining({ gameId: "skribbl" })
    )
  })

  it("opens the Poll creator from the + menu and still sends polls", () => {
    const { onSendAction } = renderCard()
    fireEvent.click(screen.getByLabelText("More actions"))
    fireEvent.click(screen.getByText("Poll"))

    fireEvent.change(screen.getByPlaceholderText("Question..."), {
      target: { value: "Lunch?" },
    })
    const options = screen.getAllByPlaceholderText(/Option/)
    fireEvent.change(options[0], { target: { value: "A" } })
    fireEvent.change(options[1], { target: { value: "B" } })
    fireEvent.click(screen.getByText("Send"))

    expect(onSendAction).toHaveBeenCalledWith(
      "poll",
      expect.objectContaining({ question: "Lunch?" })
    )
  })

  it("keeps file attachment reachable through the + menu", () => {
    const { view, onSendFile } = renderCard()
    const fileInput = view.container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    const clickSpy = vi.spyOn(fileInput, "click")
    fireEvent.click(screen.getByLabelText("More actions"))
    fireEvent.click(screen.getByText("Attach file"))
    expect(clickSpy).toHaveBeenCalled()

    // The DataChannel send flow itself is unchanged.
    expect(onSendFile).not.toHaveBeenCalled()
  })
})
