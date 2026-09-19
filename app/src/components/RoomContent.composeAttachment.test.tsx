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
  localMicState: "not_enabled" as const,
  toggleMicrophone: vi.fn(),
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
  sendRoomAppUnicast: vi.fn(() => "delivery_unavailable"),
  subscribeRoomAppUnicast: vi.fn(() => () => undefined),
  subscribeRoomAppUnicastResults: vi.fn(() => () => undefined),
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
  taskRequestId?: string,
  mimeType: RoomAttachmentProjection["mimeType"] = "text/plain",
  size = 6
): RoomAttachmentProjection {
  return {
    id,
    senderId: "human-local",
    senderName: "Hannah",
    senderKind: "human",
    fileName,
    mimeType,
    size,
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
      (_file: File, hooks?: { onReadiness?: (error?: unknown) => void }) =>
        new Promise<void>((resolve) => {
          // #363 review (point 1): a file with no applicable bounded
          // Agent-readable copy keeps today's initiation release edge.
          hooks?.onReadiness?.()
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
    expect(
      typeof (sendFileMessage.mock.calls[0][1] as { onReadiness?: unknown })
        ?.onReadiness
    ).toBe("function")
    // The composer releases the draft as soon as the readiness edge fires —
    // the whole DataChannel transfer is still pending here.
    await waitFor(() =>
      expect(screen.queryByTestId("composer-attachment")).toBeNull()
    )
    await act(async () => {
      release?.()
    })
  })

  it("withholds the text half until the readiness edge fires", async () => {
    let releaseReadiness: (() => void) | undefined
    const sendFileMessage = vi.fn(
      (_file: File, hooks?: { onReadiness?: (error?: unknown) => void }) =>
        new Promise<void>(() => {
          // The Human transfer never settles in this test; only the bounded
          // Agent-readable copy readiness edge releases the text.
          releaseReadiness = () => hooks?.onReadiness?.()
        })
    )
    const sendTextMessage = vi.fn()
    const { container } = renderRoom({ sendFileMessage, sendTextMessage })
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, "@Agent B please inspect this screenshot")
    composer.dispatchEvent(new Event("input", { bubbles: true }))

    pickFile(container, fileFixture("screenshot.png", "image/png"))
    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() => expect(sendFileMessage).toHaveBeenCalledTimes(1))
    // The file transfer has begun but the bounded copy is not published yet,
    // so the @Agent instruction is deliberately not released.
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(composer.value).toBe("@Agent B please inspect this screenshot")

    await act(async () => {
      releaseReadiness?.()
    })
    await waitFor(() => expect(sendTextMessage).toHaveBeenCalledTimes(1))
    expect(sendTextMessage.mock.calls[0][0]).toContain(
      "inspect this screenshot"
    )
    expect(composer.value).toBe("")
  })

  it("keeps a truthful draft when the bounded Agent-readable copy fails", async () => {
    const sendFileMessage = vi.fn(
      (_file: File, hooks?: { onReadiness?: (error?: unknown) => void }) => {
        hooks?.onReadiness?.(
          new Error("Couldn't publish the Agent-readable copy of this file")
        )
        return Promise.resolve()
      }
    )
    const sendTextMessage = vi.fn()
    const { container } = renderRoom({ sendFileMessage, sendTextMessage })
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, "@Agent B please inspect this screenshot")
    composer.dispatchEvent(new Event("input", { bubbles: true }))

    pickFile(container, fileFixture("screenshot.png", "image/png"))
    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Agent-readable copy")
    )
    // The draft and its error stay visible, and no partial text-only
    // submission is released as if the Agent context were complete.
    expect(screen.getByTestId("composer-attachment")).toBeInTheDocument()
    expect(composer.value).toBe("@Agent B please inspect this screenshot")
    expect(sendTextMessage).not.toHaveBeenCalled()
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
      expect(sendTaskAttachment).toHaveBeenCalledWith(file, "T", false)
    )
    expect(sendFileMessage).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(sendTextMessage).toHaveBeenCalledWith("use this", [], "T")
    )
  })

  it("asks the Room to wake the Task Agent for an attachment-only submission", async () => {
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
    pickFile(container, file)
    fireEvent.click(screen.getByLabelText("Send message"))

    // No text: the attachment is the whole submission and must wake the
    // participating Task Agent on its own.
    await waitFor(() =>
      expect(sendTaskAttachment).toHaveBeenCalledWith(file, "T", true)
    )
    expect(sendFileMessage).not.toHaveBeenCalled()
    expect(sendTextMessage).not.toHaveBeenCalled()
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

  it("previews a generated Task brief through the existing viewer", async () => {
    // #409: the auto-generated brief is an ordinary bounded Task attachment,
    // so it rides the EXISTING Room attachment projection into the existing
    // preview viewer. No new preview UI is involved.
    const readRoomAttachment = vi.fn().mockResolvedValue({
      attachment: {
        id: "brief-t",
        fileName: "task-brief.md",
        mimeType: "text/markdown",
        size: 6,
        taskRequestId: "T",
      },
      data: btoa("brief!"),
    })
    renderRoom({
      messages: [taskRequest("T", 1)],
      attachments: [
        attachment("brief-t", "task-brief.md", "T", "text/markdown", 6),
      ],
      readRoomAttachment,
    })

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    expect(screen.getByText("task-brief.md")).toBeInTheDocument()
    expect(screen.getByText("text/markdown · 6 B")).toBeInTheDocument()

    fireEvent.click(screen.getByText("Preview"))

    await waitFor(() =>
      expect(readRoomAttachment).toHaveBeenCalledWith("brief-t")
    )
    await waitFor(() => expect(screen.getByText("brief!")).toBeInTheDocument())
  })
})

describe("Task composer large-paste brief wiring (#409)", () => {
  /** Fire a paste the way a browser does, applying the default caret
   * insertion only when the composer did not prevent it. */
  function pasteText(composer: HTMLTextAreaElement, text: string): boolean {
    const notPrevented = fireEvent.paste(composer, {
      clipboardData: { getData: () => text },
    })
    if (notPrevented) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set
      const next = composer.value + text
      setter!.call(composer, next)
      composer.selectionStart = next.length
      composer.selectionEnd = next.length
      composer.dispatchEvent(new Event("input", { bubbles: true }))
    }
    return notPrevented
  }

  const PASTED_BRIEF = `\n  # Investigation brief\n\n${Array.from(
    { length: 60 },
    (_, i) => `- step ${i}: reproduce and report, do not modify code`
  ).join("\n")}\n\n  尾部空白保留  \n`

  function fileBytes(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(file)
    })
  }

  it("routes a large Task paste into the bounded task attachment path only", async () => {
    const sendFileMessage = vi.fn()
    const sendTaskAttachment = vi.fn().mockResolvedValue(undefined)
    const sendTextMessage = vi.fn()
    renderRoom({
      messages: [taskRequest("T", 1)],
      sendFileMessage,
      sendTaskAttachment,
      sendTextMessage,
    })

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    expect(PASTED_BRIEF.length).toBeGreaterThan(2000)
    expect(pasteText(composer, PASTED_BRIEF)).toBe(false)

    // The giant body never becomes inline Task conversation text.
    expect(composer.value).toBe("")
    expect(screen.getByText("task-brief.md")).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Send message"))

    // The generated brief reaches the SAME task-correlated upload the Human
    // Task attachment already uses, so the existing Room attachment
    // projection — and its existing Preview viewer — needs no new wiring.
    await waitFor(() => expect(sendTaskAttachment).toHaveBeenCalledTimes(1))
    const [file, taskId, wakeAgent] = sendTaskAttachment.mock.calls[0] as [
      File,
      string,
      boolean
    ]
    expect(taskId).toBe("T")
    expect(wakeAgent).toBe(true)
    expect(file.name).toBe("task-brief.md")
    expect(file.type).toBe("text/markdown")
    expect(new TextDecoder().decode(await fileBytes(file))).toBe(PASTED_BRIEF)
    expect(sendFileMessage).not.toHaveBeenCalled()
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it("keeps the short instruction as the single addressed Task wake", async () => {
    const sendFileMessage = vi.fn()
    const sendTaskAttachment = vi.fn().mockResolvedValue(undefined)
    const sendTextMessage = vi.fn()
    renderRoom({
      messages: [taskRequest("T", 1)],
      sendFileMessage,
      sendTaskAttachment,
      sendTextMessage,
    })

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    pasteText(composer, PASTED_BRIEF)

    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, "review only")
    composer.dispatchEvent(new Event("input", { bubbles: true }))

    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() => expect(sendTaskAttachment).toHaveBeenCalledTimes(1))
    expect(sendTaskAttachment.mock.calls[0][1]).toBe("T")
    expect(sendTaskAttachment.mock.calls[0][2]).toBe(false)
    await waitFor(() =>
      expect(sendTextMessage).toHaveBeenCalledWith("review only", [], "T")
    )
    expect(sendFileMessage).not.toHaveBeenCalled()
  })

  it("leaves a large Room composer paste as ordinary text", async () => {
    const sendFileMessage = vi.fn()
    const sendTaskAttachment = vi.fn().mockResolvedValue(undefined)
    const sendTextMessage = vi.fn()
    renderRoom({
      messages: [taskRequest("T", 1)],
      sendFileMessage,
      sendTaskAttachment,
      sendTextMessage,
    })

    // No Task selected: the ordinary Room composer.
    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    expect(pasteText(composer, PASTED_BRIEF)).toBe(true)
    expect(composer.value).toBe(PASTED_BRIEF)
    expect(screen.queryByTestId("composer-attachment")).toBeNull()

    fireEvent.click(screen.getByLabelText("Send message"))

    await waitFor(() =>
      // RoomContent always forwards the (absent) Task correlation as the
      // third argument, so the Room scope stays explicitly task-less.
      expect(sendTextMessage).toHaveBeenCalledWith(
        PASTED_BRIEF.trim(),
        [],
        undefined
      )
    )
    expect(sendTaskAttachment).not.toHaveBeenCalled()
    expect(sendFileMessage).not.toHaveBeenCalled()
  })
})
