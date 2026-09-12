import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// Observe the long-lived analytics calls without allowing the browser
// analytics fallback timer to outlive jsdom teardown.
vi.mock("@common/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@common/utils")>()
  return { ...actual, trackAnalyticsEvent: vi.fn(), umamiEvent: vi.fn() }
})

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))

import type { Message } from "@common/types"

import RoomContent from "./RoomContent"
import type { RoomAttachmentProjection } from "../room/types"

/**
 * #363: Room/active-Task attachment wiring. The Room composer keeps the
 * existing 20 MB DataChannel transfer, the active Task composer uses the
 * bounded task-correlated attachment API instead, and a Human Task
 * attachment is visible only inside its own Task interaction.
 */

const baseHookReturn = {
  participants: [] as unknown[],
  messages: [] as unknown[],
  attachments: [] as unknown[],
  taskLiveViews: {},
  agentActivities: [],
  sendTextMessage: vi.fn(),
  sendFileMessage: vi.fn(),
  sendTaskAttachment: vi.fn(),
  sendActionMessage: vi.fn(),
  getLocalRoomAuth: vi.fn(() => null),
  sendCollabResponse: vi.fn(() => true),
  sendCollabResult: vi.fn(() => true),
  sendPermissionResponse: vi.fn(() => true),
  readRoomAttachment: vi.fn(),
  localParticipantId: "human-local",
  muteSelf: vi.fn(),
  toggleScreenShare: vi.fn(),
  retryVerification: vi.fn(),
  error: "",
  connectionStatus: "connected" as string,
  resolvedRoomType: "audio" as const,
  liveTranscript: { active: false },
  liveTranscriptSegments: [],
  runtimeHosts: {},
  runtimeHostProviders: {},
  liveTranscriptMediaAvailable: false,
  startLiveTranscript: vi.fn(),
  stopLiveTranscript: vi.fn(),
  connectLocalRuntime: vi.fn(),
  runtimeConnectionStatus: "idle" as const,
  leaveRoom: vi.fn(),
  roomAppsEnabled: false,
  sendRoomAppMessage: vi.fn(() => false),
  subscribeRoomAppMessages: vi.fn(() => () => undefined),
}

const ROOM_PARTICIPANTS = [
  {
    peerId: "human-local",
    name: "Hannah",
    kind: "human",
    room: "test-room",
  },
  {
    peerId: "agent-x",
    name: "Agent X",
    kind: "agent",
    room: "test-room",
  },
]

function taskRequest(requestId: string, sequence: number): Message {
  return {
    peerId: "human-local",
    name: "Hannah",
    kind: "human",
    type: "action",
    actionType: "collab",
    sequence,
    collab: {
      requestId,
      kind: "request",
      fromParticipantId: "human-local",
      targetParticipantId: "agent-x",
      summary: requestId,
    },
  }
}

function attachment(
  id: string,
  fileName: string,
  taskRequestId?: string
): RoomAttachmentProjection {
  return {
    id,
    senderId: "human-local",
    senderName: "Hannah",
    senderKind: "human",
    fileName,
    mimeType: "text/plain",
    size: 6,
    sequence: 10,
    createdAt: 10,
    ...(taskRequestId ? { taskRequestId } : {}),
  }
}

function renderRoom(hookReturn: Record<string, unknown> = {}) {
  mockUseSfuChatRoom.mockReturnValue({
    ...baseHookReturn,
    participants: ROOM_PARTICIPANTS,
    localParticipantId: "human-local",
    getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    ...hookReturn,
  })
  return render(
    <RoomContent roomName="test-room" nickName="Hannah" roomType="audio" />
  )
}

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  })
  fireEvent.change(input)
}

function fileFixture(name = "notes.txt", type = "text/plain"): File {
  return new File([new Uint8Array(6)], name, { type })
}

beforeEach(() => {
  mockUseSfuChatRoom.mockReset()
  // jsdom doesn't implement scrollIntoView; TextChatCard calls it on every
  // message-list update.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Room composer attachment transfer (#363 A1)", () => {
  it("sends a Room file only on Send, through the existing DataChannel path", async () => {
    let release: (() => void) | undefined
    const sendFileMessage = vi.fn(
      (_file: File, onInitiated?: () => void) =>
        new Promise<void>((resolve) => {
          onInitiated?.()
          release = resolve
        })
    )
    const { container } = renderRoom({ sendFileMessage })
    const file = fileFixture("room-note.txt")

    pickFile(container, file)

    // The pick is a composer draft only.
    expect(sendFileMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() => expect(sendFileMessage).toHaveBeenCalledTimes(1))
    expect(sendFileMessage.mock.calls[0][0]).toBe(file)
    expect(typeof sendFileMessage.mock.calls[0][1]).toBe("function")
    // The composer releases the draft as soon as the local transfer begins.
    await waitFor(() =>
      expect(screen.queryByTestId("composer-attachment")).toBeNull()
    )
    await act(async () => {
      release?.()
    })
  })

  it("keeps the draft and reports the 20 MB bound without starting a transfer", async () => {
    const sendFileMessage = vi.fn()
    const { container } = renderRoom({ sendFileMessage })
    const oversized = {
      name: "huge.bin",
      type: "application/octet-stream",
      size: 21 * 1024 * 1024,
    } as unknown as File

    pickFile(container, oversized)
    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("20 MB")
    )
    expect(sendFileMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
  })

  it("keeps a truthful draft when the local transfer cannot begin", async () => {
    const sendFileMessage = vi
      .fn()
      .mockRejectedValue(new Error("SFU file data channel is unavailable"))
    const { container } = renderRoom({ sendFileMessage })
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, "look at this")
    composer.dispatchEvent(new Event("input", { bubbles: true }))

    pickFile(container, fileFixture())
    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "SFU file data channel is unavailable"
      )
    )
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(composer.value).toBe("look at this")
    expect(baseHookReturn.sendTextMessage).not.toHaveBeenCalled()
  })
})

describe("Active Task attachment path (#363 A2)", () => {
  it("uses the task-correlated bounded attachment API, never the DataChannel transfer", async () => {
    const sendFileMessage = vi.fn()
    const sendTaskAttachment = vi.fn().mockResolvedValue(undefined)
    const sendTextMessage = vi.fn()
    const { container } = renderRoom({
      messages: [taskRequest("T", 1)],
      sendFileMessage,
      sendTaskAttachment,
      sendTextMessage,
    })
    const file = fileFixture("task-note.md", "text/markdown")

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, "use this")
    composer.dispatchEvent(new Event("input", { bubbles: true }))

    pickFile(container, file)
    expect(sendTaskAttachment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() =>
      expect(sendTaskAttachment).toHaveBeenCalledWith(file, "T")
    )
    expect(sendFileMessage).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(sendTextMessage).toHaveBeenCalledWith("use this", [], "T")
    )
  })

  it("never falls back to Room scope when the Task correlation fails", async () => {
    const sendFileMessage = vi.fn()
    const sendTaskAttachment = vi
      .fn()
      .mockRejectedValue(new Error("This task is no longer active"))
    const sendTextMessage = vi.fn()
    const { container } = renderRoom({
      messages: [taskRequest("T", 1)],
      sendFileMessage,
      sendTaskAttachment,
      sendTextMessage,
    })

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    pickFile(container, fileFixture())
    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This task is no longer active"
      )
    )
    expect(sendFileMessage).not.toHaveBeenCalled()
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
  })
})

describe("Human Task attachment presentation (#363 A2)", () => {
  const attachments = [
    attachment("human-task-t", "task-t.txt", "T"),
    attachment("human-task-u", "task-u.txt", "U"),
    attachment("human-room-copy", "room-copy.txt"),
  ]

  function renderScoped() {
    renderRoom({
      messages: [taskRequest("T", 1), taskRequest("U", 2)],
      attachments,
    })
  }

  it("renders a Human Task attachment inside its own Task and never in the Room", () => {
    renderScoped()

    // Ordinary Room presentation stays free of Task attachments, and the
    // existing Human Room file copy still has no standalone timeline item.
    expect(screen.queryByText("task-t.txt")).toBeNull()
    expect(screen.queryByText("task-u.txt")).toBeNull()
    expect(screen.queryByText("room-copy.txt")).toBeNull()

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    expect(screen.getByText("task-t.txt")).toBeInTheDocument()
    expect(screen.queryByText("task-u.txt")).toBeNull()
    expect(screen.queryByText("room-copy.txt")).toBeNull()
  })

  it("never leaks Task T's attachment into Task U", () => {
    renderScoped()

    fireEvent.click(screen.getByTestId("interaction-tab-task-U"))
    expect(screen.getByText("task-u.txt")).toBeInTheDocument()
    expect(screen.queryByText("task-t.txt")).toBeNull()

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    expect(screen.getByText("task-t.txt")).toBeInTheDocument()
    expect(screen.queryByText("task-u.txt")).toBeNull()
  })
})
