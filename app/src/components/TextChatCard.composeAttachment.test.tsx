import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { UserInfo } from "@common/types"

import TextChatCard, { TASK_PASTE_ATTACHMENT_THRESHOLD } from "./TextChatCard"

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

/**
 * #409: fire a paste the way a browser does. `dispatchEvent` returns false
 * when the composer prevented the default action — that is exactly the
 * mechanism that keeps a huge pasted body out of the textarea. jsdom does
 * not implement the paste default action itself, so when the composer did
 * NOT prevent it the browser's normal caret insertion is applied here.
 */
function pasteText(composer: HTMLTextAreaElement, text: string): boolean {
  const notPrevented = fireEvent.paste(composer, {
    clipboardData: { getData: () => text },
  })
  if (notPrevented) {
    const start = composer.selectionStart ?? composer.value.length
    const end = composer.selectionEnd ?? start
    typeAtCaret(
      composer,
      composer.value.slice(0, start) + text + composer.value.slice(end),
      start + text.length
    )
  }
  return notPrevented
}

/** A realistic large brief with deliberate leading/trailing whitespace and
 * non-ASCII text: conversion must preserve every byte of it. */
function briefFixture(): string {
  const body = Array.from(
    { length: 80 },
    (_, i) => `- 需求 ${i}: 保持原始内容 exact, no normalization`
  ).join("\n")
  return `\n  # 大 brief\n\n${body}\n\n  尾部空格保留  \n`
}

/** The generated File body is exactly what the upload path POSTs, so byte
 * equality is the real "exact content" contract. jsdom's File has no
 * `text()`/`arrayBuffer()`, so read it the browser way. */
function fileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
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

    // Attachment only: the composer asks the Room to wake the Task Agent.
    expect(onSendTaskFile).toHaveBeenCalledWith(file, "task-42", true)
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
    // Text present: the attachment is Task context only, so the following
    // addressed Task text stays the single wake boundary.
    expect(onSendTaskFile).toHaveBeenCalledWith(file, "task-42", false)
  })

  it("recomputes the Task wake intent for each submission", async () => {
    const { composer, fileInput, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })
    const withText = fileFixture("with-text.md", "text/markdown")

    // First submission: attachment + text => context only.
    typeMessage(composer, "please inspect this")
    pickFile(fileInput, withText)
    await pressSend()
    expect(onSendTaskFile).toHaveBeenNthCalledWith(
      1,
      withText,
      "task-42",
      false
    )

    // Second submission from the same composer: attachment only => wakes.
    const onlyFile = fileFixture("only.md", "text/markdown")
    pickFile(fileInput, onlyFile)
    await pressSend()
    expect(onSendTaskFile).toHaveBeenNthCalledWith(2, onlyFile, "task-42", true)
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

describe("Task composer large-paste briefs (#409)", () => {
  it("turns one large Task paste into a staged brief instead of textarea text", () => {
    const { composer, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })
    const brief = briefFixture()
    expect(brief.length).toBeGreaterThan(TASK_PASTE_ATTACHMENT_THRESHOLD)

    const notPrevented = pasteText(composer, brief)

    // The default insertion was prevented, so the giant body never reaches
    // the textarea and cannot pollute the Task conversation.
    expect(notPrevented).toBe(false)
    expect(composer.value).toBe("")
    // The existing composer attachment chip carries it.
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(screen.getByText("task-brief.md")).toBeInTheDocument()
    // Still just a draft stage: nothing is sent by pasting.
    expect(onSendTaskFile).not.toHaveBeenCalled()
  })

  it("keeps the textarea usable for the short instruction after the paste", () => {
    const { composer, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })

    pasteText(composer, briefFixture())
    typeMessage(composer, "先 review，不要修改代码。")

    expect(composer.value).toBe("先 review，不要修改代码。")
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(onSendTaskFile).not.toHaveBeenCalled()
  })

  it("sends a large paste as an attachment-only wake with the exact content", async () => {
    const { composer, onSendText, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })
    const brief = briefFixture()

    pasteText(composer, brief)
    await pressSend()

    expect(onSendTaskFile).toHaveBeenCalledTimes(1)
    const [file, taskId, wakeAgent] = onSendTaskFile.mock.calls[0] as [
      File,
      string,
      boolean
    ]
    expect(taskId).toBe("task-42")
    // No text: the Task attachment path wakes the Task Agent by itself.
    expect(wakeAgent).toBe(true)
    expect(file.name).toBe("task-brief.md")
    expect(file.type).toBe("text/markdown")
    // Exact content: no trim, no normalization, no wrapper prose, no
    // truncation, and no summary.
    expect(new TextDecoder().decode(await fileBytes(file))).toBe(brief)
    // The attachment already wakes the Task: no pointless "please read
    // task-brief.md" follow-up message is sent.
    expect(onSendText).not.toHaveBeenCalled()
  })

  it("sends the brief first and the short instruction as the single wake", async () => {
    const { composer, onSendText, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })

    pasteText(composer, briefFixture())
    typeMessage(composer, "先 review，不要修改代码。")
    await pressSend()

    // Text present: the brief is Task context only, so the following
    // addressed Task text stays the single wake boundary.
    expect(onSendTaskFile).toHaveBeenCalledTimes(1)
    expect(onSendTaskFile.mock.calls[0][1]).toBe("task-42")
    expect(onSendTaskFile.mock.calls[0][2]).toBe(false)
    expect(onSendText).toHaveBeenCalledWith(
      "先 review，不要修改代码。",
      [],
      "task-42"
    )
    expect(onSendTaskFile.mock.invocationCallOrder[0]).toBeLessThan(
      onSendText.mock.invocationCallOrder[0]
    )
  })

  it("leaves a below-threshold Task paste as ordinary inline text", async () => {
    const { composer, onSendText, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })
    const short = "x".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD - 1)

    const notPrevented = pasteText(composer, short)

    // The composer did not hijack it: the ordinary textarea content stays.
    expect(notPrevented).toBe(true)
    expect(composer.value).toBe(short)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()

    await pressSend()
    expect(onSendText).toHaveBeenCalledWith(short, [], "task-42")
    expect(onSendTaskFile).not.toHaveBeenCalled()
  })

  it("keeps a paste at exactly the threshold as ordinary inline text", () => {
    const { composer } = renderCard({ taskRequestId: "task-42" })
    const atThreshold = "y".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD)

    // The rule is a strict `>`: predictable, with no off-by-one surprise.
    expect(pasteText(composer, atThreshold)).toBe(true)
    expect(composer.value).toBe(atThreshold)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
  })

  it("never silently overwrites an existing composer draft attachment", async () => {
    const { composer, fileInput, onSendTaskFile } = renderCard({
      taskRequestId: "task-42",
    })
    const picked = fileFixture("human-notes.md", "text/markdown")
    pickFile(fileInput, picked)

    const notPrevented = pasteText(composer, briefFixture())

    // The Human's own draft wins: the paste stays ordinary textarea content
    // and the single-draft composer (#363) is never replaced.
    expect(notPrevented).toBe(true)
    expect(screen.getByText("human-notes.md")).toBeInTheDocument()
    expect(screen.queryByText("task-brief.md")).toBeNull()

    await pressSend()
    // The persisted attachment is still the Human's own file. The oversized
    // text half stays the existing message validation's responsibility.
    expect(onSendTaskFile).toHaveBeenCalledTimes(1)
    expect(onSendTaskFile.mock.calls[0][0]).toBe(picked)
  })

  it("keeps a large paste as text without a task attachment path", () => {
    const { composer, onSendFile } = renderCard({
      taskRequestId: "task-42",
      onSendTaskFile: undefined,
    })
    const brief = briefFixture()

    // A generated draft would be unsendable here, so pasting stays normal.
    expect(pasteText(composer, brief)).toBe(true)
    expect(composer.value).toBe(brief)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
    expect(onSendFile).not.toHaveBeenCalled()
  })

  it("ignores a paste with no plain-text payload", () => {
    const { composer } = renderCard({ taskRequestId: "task-42" })

    // Never generate an empty attachment the Task path would reject.
    const notPrevented = fireEvent.paste(composer, {
      clipboardData: { getData: () => "" },
    })

    expect(notPrevented).toBe(true)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()
  })

  it("leaves a large paste in the ordinary Room composer as text", async () => {
    const { composer, onSendFile, onSendText, onSendTaskFile } = renderCard()
    const brief = briefFixture()

    expect(pasteText(composer, brief)).toBe(true)

    // The pasted text is preserved verbatim in the textarea; only the
    // pre-existing send-time trim applies to the outgoing message.
    expect(composer.value).toBe(brief)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()

    await pressSend()
    // Ordinary Room behaviour is completely unchanged.
    expect(onSendText).toHaveBeenCalledWith(brief.trim(), [])
    expect(onSendTaskFile).not.toHaveBeenCalled()
    expect(onSendFile).not.toHaveBeenCalled()
  })
})
