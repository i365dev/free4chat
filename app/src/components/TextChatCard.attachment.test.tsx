import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Message } from "@common/types"

import TextChatCard, {
  buildRoomTimeline,
  formatAttachmentSize,
} from "./TextChatCard"
import type {
  RoomAttachmentProjection,
  RoomAttachmentRead,
} from "../room/types"

/**
 * #234: standalone Agent-authored Room attachments become first-class Human
 * timeline items — rendered from bounded metadata, previewed through the
 * existing authenticated read path, sorted by the Room's canonical sequence,
 * and never duplicating Human browser file bubbles.
 */

const AGENT_ATTACHMENT: RoomAttachmentProjection = {
  id: "att-fib",
  senderId: "agent-pi",
  senderName: "pi-macbook",
  senderKind: "agent",
  fileName: "fib.py",
  mimeType: "text/plain",
  size: 2557,
  sequence: 4,
  createdAt: 1000,
}

const HUMAN_ATTACHMENT: RoomAttachmentProjection = {
  ...AGENT_ATTACHMENT,
  id: "att-human-copy",
  senderId: "human-h",
  senderName: "Human",
  senderKind: "human",
  sequence: 3,
}

function message(sequence: number, text: string): Message {
  return {
    peerId: "human-h",
    name: "Human",
    kind: "human",
    type: "text",
    messageId: `m-${sequence}`,
    sequence,
    text,
    createdAt: 1000,
  }
}

function renderCard(
  messages: Message[],
  attachments: RoomAttachmentProjection[],
  onReadArtifact: (attachmentId: string) => Promise<RoomAttachmentRead>
) {
  return render(
    <TextChatCard
      room="room"
      nickName="Human"
      messages={messages}
      attachments={attachments}
      participants={[]}
      onSendText={vi.fn()}
      onSendFile={vi.fn()}
      onSendAction={vi.fn()}
      localParticipantId="human-h"
      onReadArtifact={onReadArtifact}
    />
  )
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe("buildRoomTimeline (#234)", () => {
  it("merges Agent attachments with messages in canonical sequence order", () => {
    const timeline = buildRoomTimeline(
      [message(2, "hi"), message(6, "bye")],
      [{ ...AGENT_ATTACHMENT, sequence: 4 }]
    )
    expect(timeline.map((item) => item.type)).toEqual([
      "message",
      "attachment",
      "message",
    ])
    expect(timeline[1].attachment?.id).toBe("att-fib")
  })

  it("excludes Human-originated attachment copies (no duplicate file bubbles) while keeping Agent artifacts", () => {
    const timeline = buildRoomTimeline([], [HUMAN_ATTACHMENT, AGENT_ATTACHMENT])
    expect(timeline).toHaveLength(1)
    expect(timeline[0].attachment?.id).toBe("att-fib")
  })

  it("keeps sequence-less ephemeral messages at the end", () => {
    const timeline = buildRoomTimeline(
      [
        message(1, "persisted"),
        { ...message(2, "local"), sequence: undefined },
      ],
      []
    )
    expect(timeline[0].message?.text).toBe("persisted")
    expect(timeline[1].message?.text).toBe("local")
  })

  it("keeps a Human file at its causal anchor when the timeline is re-sorted", () => {
    const file: Message = {
      ...message(0, "file"),
      type: "file",
      messageId: "file-1",
      sequence: undefined,
      afterSequence: 2,
      fileName: "report.pdf",
    }
    const timeline = buildRoomTimeline(
      [message(1, "before"), file, message(3, "after")],
      []
    )

    expect(
      timeline.map((item) => item.message?.text ?? item.message?.fileName)
    ).toEqual(["before", "file", "after"])
  })

  it("formats bounded sizes for the timeline card", () => {
    expect(formatAttachmentSize(2557)).toBe("2.5 KB")
    expect(formatAttachmentSize(512)).toBe("512 B")
  })
})

describe("standalone Agent attachment rendering (#234)", () => {
  it("renders sender, file name, mime, size and a Preview action", async () => {
    const onReadArtifact = vi.fn().mockResolvedValue({
      attachment: {
        id: "att-fib",
        fileName: "fib.py",
        mimeType: "text/plain",
        size: 2557,
      },
      data: btoa("print('fib')"),
    } satisfies RoomAttachmentRead)
    renderCard([message(2, "hi")], [AGENT_ATTACHMENT], onReadArtifact)

    expect(screen.getByText("pi-macbook")).toBeTruthy()
    expect(screen.getByText("fib.py")).toBeTruthy()
    expect(screen.getByText("text/plain · 2.5 KB")).toBeTruthy()
    expect(screen.getByText("Preview")).toBeTruthy()

    fireEvent.click(screen.getByText("Preview"))
    await waitFor(() => {
      expect(onReadArtifact).toHaveBeenCalledWith("att-fib")
    })
    // The existing safe preview viewer opens with the authenticated read.
    await waitFor(() => {
      expect(screen.getByText("print('fib')")).toBeTruthy()
    })
  })

  it("never renders Human attachment copies as standalone items", () => {
    renderCard([], [HUMAN_ATTACHMENT], vi.fn())
    expect(screen.queryByText("fib.py")).toBeNull()
  })

  it("renders nothing extra when only collab-referenced artifacts exist", () => {
    renderCard([], [], vi.fn())
    expect(screen.queryByText("fib.py")).toBeNull()
  })

  it("collab result cards still view the same attachment through one shared preview", async () => {
    const collabMessage: Message = {
      peerId: "agent-pi",
      name: "pi-macbook",
      kind: "agent",
      type: "action",
      messageId: "m-9",
      sequence: 9,
      actionType: "collab",
      createdAt: 1000,
      collab: {
        requestId: "req-1",
        kind: "completed",
        fromParticipantId: "agent-pi",
        targetParticipantId: "human-h",
        summary: "done",
        attachmentIds: ["att-fib"],
      },
    }
    const onReadArtifact = vi.fn().mockResolvedValue({
      attachment: {
        id: "att-fib",
        fileName: "fib.py",
        mimeType: "text/plain",
        size: 2557,
      },
      data: btoa("print('fib')"),
    } satisfies RoomAttachmentRead)
    // The same attachment appears ONCE as a standalone item; the collab card
    // additionally shows its association with the result — no second
    // standalone entry is manufactured.
    renderCard([collabMessage], [AGENT_ATTACHMENT], onReadArtifact)
    const previewButtons = screen.getAllByText("Preview")
    expect(previewButtons.length).toBe(1)
    expect(screen.getByText(/View artifact/)).toBeTruthy()
    fireEvent.click(previewButtons[0])
    await waitFor(() => {
      expect(onReadArtifact).toHaveBeenCalledWith("att-fib")
    })
  })
})
