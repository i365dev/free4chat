import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Message } from "@common/types"

import TextChatCard from "./TextChatCard"

function collabResultMessage(): Message {
  return {
    peerId: "agent-b",
    name: "Agent B",
    kind: "agent",
    type: "action",
    messageId: "m-2",
    sequence: 2,
    actionType: "collab",
    createdAt: Date.now(),
    collab: {
      requestId: "req-1",
      kind: "completed",
      fromParticipantId: "agent-b",
      targetParticipantId: "human-h",
      summary: "Dashboard loads; console clean.",
      attachmentIds: ["att-1", "att-2"],
    },
  }
}

function renderCard(
  messages: Message[],
  onReadArtifact: (attachmentId: string) => Promise<unknown>
) {
  return render(
    <TextChatCard
      room="room"
      nickName="Human"
      messages={messages}
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
  // jsdom lacks scrollIntoView; TextChatCard auto-scrolls on new messages.
  Element.prototype.scrollIntoView = vi.fn()
})

describe("collab card artifact consumption (#117)", () => {
  it("renders one bounded action per attachmentId and fetches only on explicit click", async () => {
    const onReadArtifact = vi.fn().mockResolvedValue({
      attachment: {
        id: "att-1",
        fileName: "result.json",
        mimeType: "application/json",
        size: 3,
      },
      data: btoa("{}"),
    })
    const messages = [collabResultMessage()]
    const view = renderCard(messages, onReadArtifact)

    // No prefetch/background download while rendering.
    expect(onReadArtifact).not.toHaveBeenCalled()
    const actions = screen.getAllByText(/View artifact/)
    expect(actions.length).toBe(2)

    fireEvent.click(actions[0])
    expect(onReadArtifact).toHaveBeenCalledTimes(1)
    expect(onReadArtifact).toHaveBeenCalledWith("att-1")

    // Text-like artifact renders literally inside <pre>.
    await waitFor(() =>
      expect(screen.getByText("{}", { selector: "pre" })).toBeTruthy()
    )
    // Viewer is open: closing hides it without touching the timeline.
    fireEvent.click(screen.getByText("Close"))
    expect(screen.queryByRole("presentation")).toBeNull()
    view.unmount()
  })

  it("zero attachmentIds render no artifact controls", () => {
    const message = collabResultMessage()
    delete message.collab!.attachmentIds
    const onReadArtifact = vi.fn()
    renderCard([message], onReadArtifact)
    expect(screen.queryAllByText(/View artifact/)).toHaveLength(0)
    expect(onReadArtifact).not.toHaveBeenCalled()
  })
})
