import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn(), query: {}, pathname: "/" }),
}))

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))

vi.mock("../hooks/useTurnstile", () => ({
  useTurnstile: () => ({
    containerRef: { current: null },
    requestToken: vi.fn(),
  }),
}))

import RoomContent from "./RoomContent"
import {
  MAX_TASK_PASTE_BYTES,
  TASK_PASTE_ATTACHMENT_THRESHOLD,
} from "../common/taskPaste"

/**
 * #421 — the Start Task modal must accept a large brief directly.
 *
 * Production dogfood worked around the composer's inline bound by creating an
 * empty Task and pasting the real brief as a follow-up. That trick must not be
 * required, the exact content must be preserved, and a failed brief staging
 * must never silently start a Task with missing context.
 */

const LOCAL_PEER = "local-peer"

function hookReturn(overrides: Record<string, unknown> = {}) {
  return {
    participants: [
      {
        peerId: LOCAL_PEER,
        name: "tester",
        kind: "human" as const,
        room: "test-room",
      },
      {
        peerId: "agent-pi",
        name: "Pi",
        kind: "agent" as const,
        room: "test-room",
      },
    ],
    messages: [],
    attachments: [],
    sendTextMessage: vi.fn(),
    sendFileMessage: vi.fn(),
    sendActionMessage: vi.fn(),
    sendCollabRequest: vi.fn(() => true),
    startTaskWithBrief: vi.fn(async () => true),
    requestTaskSessions: vi.fn(),
    startTaskWithSession: vi.fn(async () => ({ ok: true })),
    sendCollabResponse: vi.fn(),
    readRoomAttachment: vi.fn(),
    getLocalRoomAuth: vi.fn(() => ({
      roomId: "test-room",
      participantId: LOCAL_PEER,
      token: "tok",
    })),
    localMicState: "not_enabled" as const,
    toggleMicrophone: vi.fn(),
    toggleScreenShare: vi.fn(),
    retryVerification: vi.fn(),
    error: "",
    connectionStatus: "connected",
    resolvedRoomType: "audio",
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    runtimeHosts: {},
    runtimeHostProviders: {},
    liveTranscriptMediaAvailable: false,
    startLiveTranscript: vi.fn(),
    stopLiveTranscript: vi.fn(),
    ...overrides,
  }
}

function openModal() {
  fireEvent.click(screen.getByRole("button", { name: "Start task with Pi" }))
}

function textarea() {
  return screen.getByLabelText("What should this Agent do?")
}

function paste(text: string) {
  fireEvent.paste(textarea(), {
    clipboardData: { getData: () => text },
  })
}

describe("Start Task with a large pasted brief (#421)", () => {
  beforeEach(() => {
    mockUseSfuChatRoom.mockReset()
  })

  it("keeps an ordinary short brief inline and never stages an attachment", () => {
    const startTaskWithBrief = vi.fn(
      async (_target: string, _summary: string, _brief: File) => true
    )
    const sendCollabRequest = vi.fn(() => true)
    mockUseSfuChatRoom.mockReturnValue(
      hookReturn({ startTaskWithBrief, sendCollabRequest })
    )
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()

    paste("Fix the flaky task settlement test")
    fireEvent.change(textarea(), {
      target: { value: "Fix the flaky task settlement test" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(screen.queryByTestId("task-brief-chip")).toBeNull()
    expect(startTaskWithBrief).not.toHaveBeenCalled()
    expect(sendCollabRequest).toHaveBeenCalledWith(
      "agent-pi",
      "Fix the flaky task settlement test"
    )
  })

  it("turns a large paste into a Task brief and starts ONE canonical Task", async () => {
    const startTaskWithBrief = vi.fn(
      async (_target: string, _summary: string, _brief: File) => true
    )
    const sendCollabRequest = vi.fn(() => true)
    mockUseSfuChatRoom.mockReturnValue(
      hookReturn({ startTaskWithBrief, sendCollabRequest })
    )
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()

    const brief = `# Big handoff\n\n${"x".repeat(
      TASK_PASTE_ATTACHMENT_THRESHOLD + 500
    )}`
    paste(brief)

    // The giant body stays out of the textarea; the chip carries it.
    expect(textarea()).toHaveValue("")
    expect(screen.getByTestId("task-brief-chip")).toHaveTextContent(
      "task-brief.md"
    )

    // A brief-only start is reachable: no empty Task trick required.
    const submit = screen.getByRole("button", { name: "Send" })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await screen.findByRole("button", { name: "Start task with Pi" })
    expect(startTaskWithBrief).toHaveBeenCalledTimes(1)
    const [target, summary, file] = startTaskWithBrief.mock.calls[0]
    expect(target).toBe("agent-pi")
    expect(summary).toBe("Big handoff")
    expect(file.name).toBe("task-brief.md")
    expect(file.size).toBe(new TextEncoder().encode(brief).byteLength)
    // The canonical Task is started exactly once, through the brief path only.
    expect(sendCollabRequest).not.toHaveBeenCalled()
  })

  it("keeps a short operator instruction as the single Task wake", async () => {
    const startTaskWithBrief = vi.fn(
      async (_target: string, _summary: string, _brief: File) => true
    )
    mockUseSfuChatRoom.mockReturnValue(hookReturn({ startTaskWithBrief }))
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()

    paste(`# Context\n\n${"y".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD + 10)}`)
    fireEvent.change(textarea(), {
      target: { value: "Ship the migration only" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await screen.findByRole("button", { name: "Start task with Pi" })
    expect(startTaskWithBrief).toHaveBeenCalledTimes(1)
    const [, summary] = startTaskWithBrief.mock.calls[0] as unknown as [
      string,
      string
    ]
    expect(summary).toBe("Ship the migration only")
  })

  it("fails closed and keeps the brief when staging does not succeed", async () => {
    const startTaskWithBrief = vi.fn(
      async (_target: string, _summary: string, _brief: File) => false
    )
    const sendCollabRequest = vi.fn(() => true)
    mockUseSfuChatRoom.mockReturnValue(
      hookReturn({ startTaskWithBrief, sendCollabRequest })
    )
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()

    paste(`# Context\n\n${"z".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD + 10)}`)
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(
      await screen.findByText(/the task was not started/i)
    ).toBeInTheDocument()
    // The modal stays open with the brief intact, and NO Task was created.
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("task-brief-chip")).toBeInTheDocument()
    expect(sendCollabRequest).not.toHaveBeenCalled()
  })

  it("refuses a paste beyond the bounded Task attachment store instead of truncating", () => {
    const startTaskWithBrief = vi.fn(
      async (_target: string, _summary: string, _brief: File) => true
    )
    mockUseSfuChatRoom.mockReturnValue(hookReturn({ startTaskWithBrief }))
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()

    paste("x".repeat(MAX_TASK_PASTE_BYTES + 1))

    expect(screen.queryByTestId("task-brief-chip")).toBeNull()
    expect(
      screen.getByText(/larger than a task brief can hold/i)
    ).toBeInTheDocument()
    // Nothing silently started; the primary action stays unavailable.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    expect(startTaskWithBrief).not.toHaveBeenCalled()
  })

  it("lets the Human drop a staged brief and start a normal Task again", () => {
    const startTaskWithBrief = vi.fn(
      async (_target: string, _summary: string, _brief: File) => true
    )
    const sendCollabRequest = vi.fn(() => true)
    mockUseSfuChatRoom.mockReturnValue(
      hookReturn({ startTaskWithBrief, sendCollabRequest })
    )
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()

    paste(`# Context\n\n${"q".repeat(TASK_PASTE_ATTACHMENT_THRESHOLD + 10)}`)
    fireEvent.click(
      screen.getByRole("button", { name: "Remove the attached brief" })
    )
    expect(screen.queryByTestId("task-brief-chip")).toBeNull()

    fireEvent.change(textarea(), { target: { value: "Short brief" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    expect(startTaskWithBrief).not.toHaveBeenCalled()
    expect(sendCollabRequest).toHaveBeenCalledWith("agent-pi", "Short brief")
  })
})
