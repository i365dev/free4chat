import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { UserInfo } from "@common/types"

import TextChatCard from "./TextChatCard"

/**
 * #363 A1/A2: the Room composer is compose-first for attachments. Picking a
 * file only stages it; one Send initiates the existing file and text
 * operations together. In an ACTIVE Task the same Send routes the file
 * through the bounded, task-correlated attachment path instead of the
 * ordinary Room DataChannel transfer.
 */

function agentParticipant(): UserInfo {
  return {
    peerId: "agent-1",
    name: "Agent B",
    kind: "agent",
    room: "room",
  }
}

function fileFixture(name = "notes.txt", type = "text/plain", size = 12): File {
  return new File([new Uint8Array(size)], name, { type })
}

function renderCard(
  props: Partial<React.ComponentProps<typeof TextChatCard>> = {}
) {
  const onSendText = vi.fn()
  const onSendFile = vi.fn().mockResolvedValue(undefined)
  const onSendTaskFile = vi.fn().mockResolvedValue(undefined)
  const onSendAction = vi.fn()
  const view = render(
    <TextChatCard
      room="room"
      nickName="Human"
      messages={[]}
      participants={[agentParticipant()]}
      onSendText={onSendText}
      onSendFile={onSendFile}
      onSendTaskFile={onSendTaskFile}
      onSendAction={onSendAction}
      {...props}
    />
  )
  const composer = screen.getByLabelText(
    "Message the room or @ an Agent"
  ) as HTMLTextAreaElement
  const fileInput = view.container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement
  return {
    view,
    onSendText,
    onSendFile,
    onSendTaskFile,
    onSendAction,
    composer,
    fileInput,
  }
}

function pickFile(fileInput: HTMLInputElement, file: File) {
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [file],
  })
  fireEvent.change(fileInput)
}

/** One Send action, flushed inside act so the awaited local initiation and
 * the following text half settle inside React's update scope. */
async function pressSend() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Send message"))
  })
}

async function pressEnter(composer: HTMLTextAreaElement) {
  await act(async () => {
    fireEvent.keyDown(composer, { key: "Enter" })
  })
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
  vi.restoreAllMocks()
})

describe("Room composer: compose-first attachments (#363 A1)", () => {
  it("stages a picked file in the composer and does not send it", () => {
    const { fileInput, onSendFile } = renderCard()
    const file = fileFixture("diagram.png", "image/png")

    pickFile(fileInput, file)

    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(screen.getByText("diagram.png")).toBeInTheDocument()
    expect(onSendFile).not.toHaveBeenCalled()
  })

  it("removes a pending attachment before Send", () => {
    const { fileInput, onSendFile } = renderCard()

    pickFile(fileInput, fileFixture())
    fireEvent.click(screen.getByLabelText("Remove attachment"))

    expect(screen.queryByTestId("composer-attachment")).toBeNull()
    expect(onSendFile).not.toHaveBeenCalled()
  })

  it("still sends text only when nothing is pending", () => {
    const { composer, onSendText, onSendFile } = renderCard()

    typeMessage(composer, "hello room")
    fireEvent.click(screen.getByLabelText("Send message"))

    expect(onSendText).toHaveBeenCalledWith("hello room", [])
    expect(onSendFile).not.toHaveBeenCalled()
    expect(composer.value).toBe("")
  })

  it("sends an attachment only from the Send action", async () => {
    const { composer, fileInput, onSendFile, onSendText } = renderCard()
    const file = fileFixture("notes.txt")

    pickFile(fileInput, file)
    // An attachment alone is a complete submission: Send is enabled.
    expect(screen.getByLabelText("Send message")).toBeEnabled()
    await pressSend()

    expect(onSendFile).toHaveBeenCalledWith(file)
    expect(onSendText).not.toHaveBeenCalled()
    expect(composer.value).toBe("")
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
  })

  it("initiates the file and the text as one Send action", async () => {
    const { composer, fileInput, onSendFile, onSendText } = renderCard()
    const file = fileFixture("notes.txt")

    typeMessage(composer, "  please review  ")
    pickFile(fileInput, file)
    await pressSend()

    expect(onSendText).toHaveBeenCalledWith("please review", [])
    expect(onSendFile).toHaveBeenCalledWith(file)
    // The local file initiation is attempted before the text half.
    expect(onSendFile.mock.invocationCallOrder[0]).toBeLessThan(
      onSendText.mock.invocationCallOrder[0]
    )
    expect(composer.value).toBe("")
  })

  it("keeps resolved @Agent targets correct with an attachment present", async () => {
    const { composer, fileInput, onSendFile, onSendText } = renderCard()

    typeAtCaret(composer, "@Age please review", 4)
    fireEvent.mouseDown(await screen.findByText("Agent B"))
    await waitFor(() => expect(composer.value).toContain("@Agent B "))

    pickFile(fileInput, fileFixture("context.md", "text/markdown"))
    await pressEnter(composer)

    expect(onSendText).toHaveBeenCalledWith(
      expect.stringContaining("@Agent B"),
      ["agent-1"]
    )
    expect(onSendFile).toHaveBeenCalled()
  })

  it("keeps a truthful retry state when the local attachment cannot begin", async () => {
    const onSendFile = vi
      .fn()
      .mockRejectedValue(new Error("SFU file data channel is unavailable"))
    const { composer, fileInput, onSendText } = renderCard({ onSendFile })
    const file = fileFixture("notes.txt")

    typeMessage(composer, "please review")
    pickFile(fileInput, file)
    await pressSend()

    expect(screen.getByRole("alert")).toHaveTextContent(
      "SFU file data channel is unavailable"
    )
    // The pending attachment is never silently cleared, and the obviously
    // partial text-only submission is never sent.
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(composer.value).toBe("please review")
    expect(onSendText).not.toHaveBeenCalled()

    // Both retry and remove stay available.
    expect(screen.getByLabelText("Send message")).toBeEnabled()
    fireEvent.click(screen.getByLabelText("Remove attachment"))
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
  })

  it("retries the same pending attachment after a failed local initiation", async () => {
    const onSendFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("SFU file data channel is unavailable"))
      .mockResolvedValueOnce(undefined)
    const {
      fileInput,
      onSendFile: _ignored,
      onSendText,
    } = renderCard({
      onSendFile,
    })
    void _ignored
    const file = fileFixture("notes.txt")

    pickFile(fileInput, file)
    await pressSend()
    expect(screen.getByRole("alert")).toBeInTheDocument()

    await pressSend()

    expect(onSendFile).toHaveBeenCalledTimes(2)
    expect(onSendFile).toHaveBeenNthCalledWith(2, file)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
    expect(onSendText).not.toHaveBeenCalled()
  })

  it("does not clear the pending attachment while the send is in flight", async () => {
    let release: (() => void) | undefined
    const onSendFile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const { fileInput } = renderCard({ onSendFile })

    pickFile(fileInput, fileFixture())
    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    // A second Send cannot duplicate the submission.
    expect(screen.getByLabelText("Send message")).toBeDisabled()

    await act(async () => {
      release?.()
    })
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
  })
})

describe("Active Task composer attachments (#363 A2)", () => {
  it("exposes a small attach affordance that only stages the file", () => {
    const { fileInput, onSendTaskFile, onSendFile } = renderCard({
      taskRequestId: "task-42",
    })

    // The ordinary Room "+" menu stays hidden inside a Task composer.
    expect(screen.queryByLabelText("More actions")).not.toBeInTheDocument()
    const attach = screen.getByLabelText("Attach a file to this task")
    const clickSpy = vi.spyOn(fileInput, "click")
    fireEvent.click(attach)

    expect(clickSpy).toHaveBeenCalled()
    expect(onSendTaskFile).not.toHaveBeenCalled()
    expect(onSendFile).not.toHaveBeenCalled()
  })

  it("sends the file through the task-correlated path with the exact taskRequestId", async () => {
    const { fileInput, onSendFile, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })
    const file = fileFixture("task-notes.md", "text/markdown")

    pickFile(fileInput, file)
    await pressSend()

    expect(onSendTaskFile).toHaveBeenCalledWith(file, "task-42")
    // Never the ordinary 20 MB Room DataChannel transfer.
    expect(onSendFile).not.toHaveBeenCalled()
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
  })

  it("still sends task text and the attachment as one Send action", async () => {
    const { composer, fileInput, onSendTaskFile, onSendText } = renderCard({
      taskRequestId: "task-42",
    })
    const file = fileFixture("task-notes.md", "text/markdown")

    typeMessage(composer, "summarize this")
    pickFile(fileInput, file)
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() =>
      expect(onSendText).toHaveBeenCalledWith("summarize this", [], "task-42")
    )
    expect(onSendTaskFile).toHaveBeenCalledWith(file, "task-42")
  })

  it("keeps the Task draft when the task correlation fails closed", async () => {
    const onSendTaskFile = vi
      .fn()
      .mockRejectedValue(new Error("This task is no longer active"))
    const { composer, fileInput, onSendText } = renderCard({
      taskRequestId: "task-42",
      onSendTaskFile,
    })

    typeMessage(composer, "still relevant?")
    pickFile(fileInput, fileFixture())
    await pressSend()

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This task is no longer active"
    )
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(composer.value).toBe("still relevant?")
    // Never silently downgraded to an ordinary Room send.
    expect(onSendText).not.toHaveBeenCalled()
  })

  it("never falls back to the Room transfer without a task attachment path", async () => {
    const { fileInput, onSendFile } = renderCard({
      taskRequestId: "task-42",
      onSendTaskFile: undefined,
    })

    // No Task attachment affordance exists without the task-correlated path.
    expect(
      screen.queryByLabelText("Attach a file to this task")
    ).not.toBeInTheDocument()

    pickFile(fileInput, fileFixture())
    await pressSend()

    expect(onSendFile).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Attachments aren't available in this task"
    )
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
  })
})
