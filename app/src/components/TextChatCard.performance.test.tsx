import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Message, UserInfo } from "@common/types"

const markdownRenderCount = vi.hoisted(() => ({ value: 0 }))

// Keep this fixture focused on render counts rather than Markdown parser
// details. The existing composer and Markdown behavior suites cover those
// semantics separately.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: React.ReactNode }) => {
    markdownRenderCount.value += 1
    return <div data-testid="markdown-row">{children}</div>
  },
}))

vi.mock("./ParticipantAvatar", () => ({
  default: ({ name }: { name: string }) => (
    <span data-testid="avatar">{name}</span>
  ),
}))

import TextChatCard from "./TextChatCard"
import type { RoomAttachmentProjection } from "../room/types"

const PARTICIPANTS: UserInfo[] = [
  {
    peerId: "agent-a",
    name: "Agent A",
    kind: "agent",
    room: "room-perf-test",
  },
  {
    peerId: "agent-b",
    name: "Agent B",
    kind: "agent",
    room: "room-perf-test",
  },
]

function textMessage(sequence: number): Message {
  return {
    peerId: sequence % 2 === 0 ? "agent-a" : "agent-b",
    name: sequence % 2 === 0 ? "Agent A" : "Agent B",
    kind: "agent",
    type: "text",
    messageId: `message-${sequence}`,
    sequence,
    text: `## message-${sequence}\n\nA long synthetic Markdown reply with inline code and a list.`,
  }
}

function renderCard(
  messages: Message[],
  attachments: RoomAttachmentProjection[] = []
) {
  return render(
    <TextChatCard
      room="room-perf-test"
      nickName="Human A"
      messages={messages}
      attachments={attachments}
      participants={PARTICIPANTS}
      pendingFiles={[]}
      onSendText={vi.fn()}
      onSendFile={vi.fn()}
      onSendAction={vi.fn()}
    />
  )
}

function typeMessage(composer: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, value)
    composer.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

beforeEach(() => {
  markdownRenderCount.value = 0
  Element.prototype.scrollIntoView = vi.fn()
})

describe("long timeline render isolation (#280)", () => {
  it("does not re-render historical Markdown rows while typing", () => {
    const messages = [textMessage(1), textMessage(2), textMessage(3)]
    renderCard(messages)
    expect(markdownRenderCount.value).toBe(messages.length)

    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    typeMessage(composer, "h")
    typeMessage(composer, "he")
    typeMessage(composer, "hey")

    expect(markdownRenderCount.value).toBe(messages.length)
  })

  it("only renders the appended Markdown row when one message arrives", () => {
    const firstMessages = [textMessage(1), textMessage(2)]
    const attachments: RoomAttachmentProjection[] = []
    const onSendText = vi.fn()
    const onSendFile = vi.fn()
    const onSendAction = vi.fn()
    const view = render(
      <TextChatCard
        room="room-perf-test"
        nickName="Human A"
        messages={firstMessages}
        attachments={attachments}
        participants={PARTICIPANTS}
        pendingFiles={[]}
        onSendText={onSendText}
        onSendFile={onSendFile}
        onSendAction={onSendAction}
      />
    )
    expect(markdownRenderCount.value).toBe(2)

    view.rerender(
      <TextChatCard
        room="room-perf-test"
        nickName="Human A"
        messages={[...firstMessages, textMessage(3)]}
        attachments={attachments}
        participants={PARTICIPANTS}
        pendingFiles={[]}
        onSendText={onSendText}
        onSendFile={onSendFile}
        onSendAction={onSendAction}
      />
    )

    expect(markdownRenderCount.value).toBe(3)
  })

  it("renders a few hundred mixed synthetic entries with the same visible rows", () => {
    const messages = Array.from({ length: 260 }, (_, index) =>
      textMessage(index + 1)
    )
    const attachments: RoomAttachmentProjection[] = Array.from(
      { length: 20 },
      (_, index) => ({
        id: `attachment-${index}`,
        senderId: "agent-a",
        senderName: "Agent A",
        senderKind: "agent" as const,
        fileName: `artifact-${index}.txt`,
        mimeType: "text/plain",
        size: 128,
        sequence: 261 + index,
        createdAt: 1000 + index,
      })
    )

    renderCard(messages, attachments)

    expect(markdownRenderCount.value).toBe(messages.length)
    expect(screen.getByText("artifact-19.txt")).toBeInTheDocument()
    expect(screen.getByText(/message-260/)).toBeInTheDocument()
  })
})
