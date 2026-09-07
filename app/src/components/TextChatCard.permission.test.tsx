import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Message, UserInfo } from "@common/types"

import TextChatCard from "./TextChatCard"

const AGENT: UserInfo = {
  peerId: "agent-a",
  name: "Agent A",
  kind: "agent",
  room: "permission-room",
}

function permissionRequest(): Message {
  return {
    peerId: "agent-a",
    name: "Agent A",
    kind: "agent",
    type: "action",
    actionType: "permission",
    messageId: "message-1",
    sequence: 1,
    permission: {
      requestId: "permission-1",
      kind: "request",
      agentParticipantId: "agent-a",
      toolCall: {
        title: "Run command",
        kind: "execute",
        summary: "npm install",
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      createdAt: 1,
      expiresAt: 1000,
    },
  }
}

function renderCard(messages: Message[], onPermissionRespond = vi.fn()) {
  return {
    onPermissionRespond,
    ...render(
      <TextChatCard
        room="permission-room"
        nickName="Human"
        messages={messages}
        participants={[AGENT]}
        onSendText={vi.fn()}
        onSendFile={vi.fn()}
        onSendAction={vi.fn()}
        onPermissionRespond={onPermissionRespond}
      />
    ),
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

describe("permission timeline card (#286)", () => {
  it("renders the Agent tool presentation and exact native options", () => {
    renderCard([permissionRequest()])

    expect(screen.getByText("Agent A needs permission")).toBeTruthy()
    expect(screen.getByText("Run command")).toBeTruthy()
    expect(screen.getByText("npm install")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy()
  })

  it("sends the exact selected option through the structured callback", () => {
    const onPermissionRespond = vi.fn()
    renderCard([permissionRequest()], onPermissionRespond)

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(onPermissionRespond).toHaveBeenCalledWith(
      "permission-1",
      "allow-once"
    )
  })

  it("disables options after a canonical resolution", () => {
    const request = permissionRequest()
    const resolved: Message = {
      peerId: "human-1",
      name: "Human One",
      kind: "human",
      type: "action",
      actionType: "permission",
      messageId: "message-2",
      sequence: 2,
      permission: {
        requestId: "permission-1",
        kind: "resolved",
        agentParticipantId: "agent-a",
        selectedOptionId: "allow-once",
        humanParticipantId: "human-1",
        humanName: "Human One",
        createdAt: 2,
        expiresAt: 1000,
      },
    }
    renderCard([request, resolved])

    expect(screen.getByTestId("permission-resolution").textContent).toContain(
      "Selected Allow once by Human One"
    )
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled()
  })

  it("does not turn ordinary text into an approval card", () => {
    const ordinary: Message = {
      peerId: "agent-a",
      name: "Agent A",
      kind: "agent",
      type: "text",
      text: "yes",
      messageId: "message-text",
      sequence: 1,
    }
    renderCard([ordinary])

    expect(screen.queryByText("needs permission")).toBeNull()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
  })
})
