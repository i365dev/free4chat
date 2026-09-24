import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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

const LOCAL_PEER = "local-peer"

function participants(continuation: boolean) {
  return [
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
      taskSessionContinuation: continuation,
    },
  ]
}

function hookReturn(overrides: Record<string, unknown> = {}) {
  return {
    participants: participants(true),
    messages: [],
    attachments: [],
    sendTextMessage: vi.fn(),
    sendFileMessage: vi.fn(),
    sendActionMessage: vi.fn(),
    sendCollabRequest: vi.fn(() => true),
    requestTaskSessions: vi.fn(async () => ({
      ok: true,
      page: {
        sessions: [
          {
            token: "token-1",
            title: "Fix shooter interpolation",
            projectToken: "project-1",
            projectLabel: "~/workspace/free4chat",
            updatedAt: new Date(Date.now() - 38 * 60 * 1000).toISOString(),
          },
        ],
        projects: [{ token: "project-1", label: "~/workspace/free4chat" }],
        hasMore: false,
      },
    })),
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

function openModal(name = "Start task with Pi") {
  fireEvent.click(screen.getByRole("button", { name }))
}

function typeInstruction(text: string) {
  fireEvent.change(screen.getByLabelText("What should this Agent do?"), {
    target: { value: text },
  })
}

describe("Start Task with an existing local session (#409)", () => {
  beforeEach(() => {
    mockUseSfuChatRoom.mockReset()
  })

  it("leaves the modal essentially unchanged for an Agent that does not support continuation", () => {
    mockUseSfuChatRoom.mockReturnValue(
      hookReturn({ participants: participants(false) })
    )
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByTestId("task-session-mode")).toBeNull()
    expect(screen.queryByTestId("task-session-list")).toBeNull()
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
  })

  it("offers New and Continue for a supporting Agent, defaulting to New with no discovery", () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    expect(screen.getByTestId("task-session-mode-new")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByTestId("task-session-mode-continue")).toHaveAttribute(
      "aria-checked",
      "false"
    )
    // Opening the modal must NOT export local session metadata.
    expect(hook.requestTaskSessions).not.toHaveBeenCalled()
    expect(screen.queryByTestId("task-session-list")).toBeNull()
    // New session keeps the ordinary submit label semantics.
    expect(
      screen.getByRole("button", { name: "Start task" })
    ).toBeInTheDocument()
  })

  it("discovers lazily and renders the recent sessions", async () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await waitFor(() =>
      expect(hook.requestTaskSessions).toHaveBeenCalledWith("agent-pi", {})
    )
    expect(await screen.findByTestId("task-session-list")).toBeInTheDocument()
    expect(screen.getByText("Fix shooter interpolation")).toBeInTheDocument()
    expect(
      screen.getByText(/~\/workspace\/free4chat · 38 min ago/)
    ).toBeInTheDocument()
  })

  it("keeps the modal compact and the rows bounded at a 390px viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    })
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await screen.findByTestId("task-session-list")
    const list = screen.getByTestId("task-session-list")
    expect(list.className).toContain("max-h-60")
    expect(list.className).toContain("overflow-y-auto")
    const dialog = screen.getByRole("dialog")
    const panel = dialog.querySelector("form")
    expect(panel?.className).toContain("w-full")
    expect(panel?.className).toContain("max-w-md")
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    })
  })

  it("shows an actionable error and can retry discovery", async () => {
    const requestTaskSessions = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "session_continuation_unavailable",
      })
      .mockResolvedValueOnce({
        ok: true,
        page: { sessions: [], projects: [], hasMore: false },
      })
    const hook = hookReturn({ requestTaskSessions })
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    expect(await screen.findByTestId("task-session-error")).toHaveTextContent(
      "Your instruction was not sent."
    )
    fireEvent.click(screen.getByTestId("task-session-retry"))
    await waitFor(() => expect(requestTaskSessions).toHaveBeenCalledTimes(2))
  })

  it("loads more without duplicating rows and keeps the modal bounded", async () => {
    const requestTaskSessions = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        page: {
          sessions: [
            {
              token: "token-1",
              title: "First page row",
              projectToken: "project-1",
              projectLabel: "~/a",
            },
          ],
          projects: [{ token: "project-1", label: "~/a" }],
          nextPageToken: "page-token-1",
          hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        page: {
          sessions: [
            {
              token: "token-1",
              title: "First page row",
              projectToken: "project-1",
              projectLabel: "~/a",
            },
            {
              token: "token-2",
              title: "Second page row",
              projectToken: "project-2",
              projectLabel: "~/b",
            },
          ],
          projects: [{ token: "project-2", label: "~/b" }],
          hasMore: false,
        },
      })
    const hook = hookReturn({ requestTaskSessions })
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await screen.findByTestId("task-session-load-more")
    fireEvent.click(screen.getByTestId("task-session-load-more"))
    await waitFor(() =>
      expect(screen.getAllByTestId("task-session-row")).toHaveLength(2)
    )
    expect(requestTaskSessions).toHaveBeenLastCalledWith("agent-pi", {
      pageToken: "page-token-1",
    })
    // The appended page must not grow the list beyond the bounded container.
    expect(screen.getByTestId("task-session-list").className).toContain(
      "max-h-60"
    )
  })

  it("re-runs Runtime → Harness discovery on an explicit Refresh", async () => {
    const requestTaskSessions = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        page: {
          sessions: [
            {
              token: "token-1",
              title: "Session A",
              projectToken: "project-1",
              projectLabel: "~/a",
            },
          ],
          projects: [{ token: "project-1", label: "~/a" }],
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        page: {
          sessions: [
            {
              token: "token-2",
              title: "Session A",
              projectToken: "project-1",
              projectLabel: "~/a",
            },
            {
              token: "token-3",
              title: "Session C",
              projectToken: "project-1",
              projectLabel: "~/a",
            },
          ],
          projects: [{ token: "project-1", label: "~/a" }],
          hasMore: false,
        },
      })
    const hook = hookReturn({ requestTaskSessions })
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await screen.findByTestId("task-session-list")
    expect(screen.getAllByTestId("task-session-row")).toHaveLength(1)

    // A Refresh is a real Runtime → Harness round trip: no page token, and the
    // provider's NEW session appears immediately.
    fireEvent.click(screen.getByTestId("task-session-refresh"))
    await waitFor(() =>
      expect(screen.getAllByTestId("task-session-row")).toHaveLength(2)
    )
    expect(screen.getByText("Session C")).toBeInTheDocument()
    expect(requestTaskSessions).toHaveBeenCalledTimes(2)
    expect(requestTaskSessions).toHaveBeenLastCalledWith("agent-pi", {})
  })

  it("re-discovers from scratch every time the modal is reopened", async () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await screen.findByTestId("task-session-list")
    expect(hook.requestTaskSessions).toHaveBeenCalledTimes(1)

    // Close and reopen: the picker must not replay the previous rows, and
    // Continue must ask the Runtime again.
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    openModal()
    expect(screen.queryByTestId("task-session-list")).toBeNull()
    expect(screen.getByTestId("task-session-mode-new")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await waitFor(() =>
      expect(hook.requestTaskSessions).toHaveBeenCalledTimes(2)
    )
    expect(hook.requestTaskSessions).toHaveBeenLastCalledWith("agent-pi", {})
  })

  it("keeps the typed instruction while a session is selected", async () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    typeInstruction("Continue fixing the interpolation bug")
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    fireEvent.click(await screen.findByTestId("task-session-row"))
    expect(screen.getByTestId("task-session-row")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByLabelText("What should this Agent do?")).toHaveValue(
      "Continue fixing the interpolation bug"
    )
  })

  it("shows Starting…, then closes the modal on success", async () => {
    let resolveStart: (value: { ok: true }) => void = () => undefined
    const startTaskWithSession = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveStart = resolve
        })
    )
    const hook = hookReturn({ startTaskWithSession })
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    typeInstruction("Continue this work")
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    fireEvent.click(await screen.findByTestId("task-session-row"))
    fireEvent.click(screen.getByRole("button", { name: "Start task" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled()
    )
    // The New-session path must NOT be used for a Continue start.
    expect(hook.sendCollabRequest).not.toHaveBeenCalled()
    expect(startTaskWithSession).toHaveBeenCalledWith(
      "agent-pi",
      "token-1",
      "Continue this work",
      undefined,
      undefined,
      {}
    )
    resolveStart({ ok: true })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("keeps the modal open with the instruction when the start fails", async () => {
    const startTaskWithSession = vi.fn(async () => ({
      ok: false as const,
      error: "session_selection_expired" as const,
    }))
    const hook = hookReturn({ startTaskWithSession })
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    typeInstruction("Continue this work")
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    fireEvent.click(await screen.findByTestId("task-session-row"))
    fireEvent.click(screen.getByRole("button", { name: "Start task" }))

    expect(
      await screen.findByText(
        "This local session is no longer available. Refresh sessions and try again."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByLabelText("What should this Agent do?")).toHaveValue(
      "Continue this work"
    )
    expect(hook.sendCollabRequest).not.toHaveBeenCalled()
  })

  it("requires an explicit selection before Start is available", async () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    typeInstruction("Continue this work")
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await screen.findByTestId("task-session-list")
    expect(screen.getByRole("button", { name: "Start task" })).toBeDisabled()
  })

  it("uses the ordinary collaboration request while New session is selected", async () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    typeInstruction("A brand new task")
    fireEvent.click(screen.getByRole("button", { name: "Start task" }))
    await waitFor(() =>
      expect(hook.sendCollabRequest).toHaveBeenCalledWith(
        "agent-pi",
        "A brand new task"
      )
    )
    expect(hook.startTaskWithSession).not.toHaveBeenCalled()
  })

  it("abandons the picker when the Human switches back to New session", async () => {
    const hook = hookReturn()
    mockUseSfuChatRoom.mockReturnValue(hook)
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    await screen.findByTestId("task-session-list")
    fireEvent.click(screen.getByTestId("task-session-mode-new"))
    expect(screen.queryByTestId("task-session-list")).toBeNull()
    expect(screen.getByTestId("task-session-mode-new")).toHaveAttribute(
      "aria-checked",
      "true"
    )
  })

  it("renders an untrusted session title as plain text", async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">'
    const hook = hookReturn({
      requestTaskSessions: vi.fn(async () => ({
        ok: true,
        page: {
          sessions: [
            {
              token: "token-x",
              title: hostile,
              projectToken: "project-1",
              projectLabel: "~/x",
            },
          ],
          projects: [],
          hasMore: false,
        },
      })),
    })
    mockUseSfuChatRoom.mockReturnValue(hook)
    const { container } = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    openModal()
    fireEvent.click(screen.getByTestId("task-session-mode-continue"))
    expect(await screen.findByText(hostile)).toBeInTheDocument()
    expect(container.querySelector("img")).toBeNull()
  })
})
