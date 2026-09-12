import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// Observe the long-lived analytics calls (AgentInviteCopied,
// LiveTranscriptStarted/Stopped) without allowing the browser analytics
// fallback timer to outlive jsdom teardown.
vi.mock("@common/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@common/utils")>()
  return { ...actual, trackAnalyticsEvent: vi.fn(), umamiEvent: vi.fn() }
})

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))

import type { Message } from "@common/types"
import { trackAnalyticsEvent } from "@common/utils"

import RoomContent from "./RoomContent"
import { roomAppInstanceId } from "../common/roomApp"
import { RoomSession } from "../do/RoomSession"
import type { RoomRecord, RoomState } from "../room/types"

interface RenderOptions {
  callback: (token: string) => void
  "error-callback": () => boolean | void
}

function installMockTurnstile() {
  let widgetCounter = 0
  let lastOptions: RenderOptions | null = null
  const render = vi.fn(
    (_container: string | HTMLElement, options: Record<string, unknown>) => {
      lastOptions = options as unknown as RenderOptions
      widgetCounter += 1
      return `widget-${widgetCounter}`
    }
  )
  const execute = vi.fn()
  const reset = vi.fn()
  const remove = vi.fn()

  window.turnstile = { render, execute, reset, remove }

  return {
    render,
    execute,
    reset,
    remove,
    fireSuccess: (token: string) => lastOptions?.callback(token),
  }
}

const baseHookReturn = {
  participants: [] as unknown[],
  messages: [] as unknown[],
  sendTextMessage: vi.fn(),
  sendFileMessage: vi.fn(),
  sendActionMessage: vi.fn(),
  getLocalRoomAuth: vi.fn(() => null),
  sendCollabResponse: vi.fn(() => true),
  localParticipantId: "human-local",
  muteSelf: vi.fn(),
  toggleScreenShare: vi.fn(),
  retryVerification: vi.fn(),
  error: "",
  expiryWarning: "",
  connectionStatus: "verifying" as string,
  resolvedRoomType: "audio" as const,
  timeLeft: 0,
  liveTranscript: { active: false } as { active: boolean },
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

const LATE_JOIN_EXPIRY = Date.now() + 365 * 24 * 60 * 60 * 1000

// Shared fixtures for the Room App Stage tests: one Task conversation and its
// bounded Live View surface.
const taskRequestMessage: Message = {
  peerId: "local-peer",
  name: "Alice",
  kind: "human",
  type: "action",
  actionType: "collab",
  sequence: 1,
  collab: {
    requestId: "task-live",
    kind: "request",
    fromParticipantId: "local-peer",
    targetParticipantId: "agent-a",
    summary: "Counter",
  },
}

const taskLiveViewSnapshot = {
  taskRequestId: "task-live",
  surfaceId: "counter",
  authorityAgentId: "agent-a",
  revision: 1,
  root: {
    type: "Column",
    children: [
      { type: "Text", text: "Count" },
      {
        type: "Button",
        label: "+1",
        action: { type: "increment", path: "count", amount: 1 },
      },
    ],
  },
  data: { count: 0 },
}

function lateJoinRoom(): RoomRecord {
  return {
    createdAt: 1,
    expiresAt: LATE_JOIN_EXPIRY,
    participants: {
      "human-a": {
        id: "human-a",
        name: "Human A",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        token: "human-a-token",
      },
      "agent-a": {
        id: "agent-a",
        name: "Agent A",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: 1,
        token: "agent-a-token",
      },
    },
    messages: [
      {
        id: "late-join-task-request",
        peerId: "human-a",
        name: "Human A",
        kind: "human",
        type: "action",
        actionType: "collab",
        sequence: 1,
        createdAt: 1,
        collab: {
          requestId: "late-join-task",
          kind: "request",
          fromParticipantId: "human-a",
          targetParticipantId: "agent-a",
          summary: "Existing Task",
        },
        targets: ["agent-a"],
      },
    ],
    nextMessageSequence: 1,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    nextLiveTranscriptEpoch: 1,
    nextTranscriptSequence: 1,
    attachments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function lateJoinSurface() {
  return {
    taskRequestId: "late-join-task",
    surfaceId: "counter",
    authorityAgentId: "agent-a",
    revision: 1,
    root: {
      type: "Card",
      children: [
        { type: "Text", text: "Count" },
        { type: "Value", path: "count" },
      ],
    },
    data: { count: 0 },
  }
}

function lateJoinSession(store: Map<string, unknown>) {
  return new RoomSession(
    {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value)
        },
        delete: async (key: string | string[]) => {
          for (const candidate of Array.isArray(key) ? key : [key])
            store.delete(candidate)
        },
        list: async (options?: { prefix?: string; limit?: number }) => {
          const entries = [...store.entries()].filter(([key]) =>
            options?.prefix ? key.startsWith(options.prefix) : true
          )
          return new Map(entries.slice(0, options?.limit ?? entries.length))
        },
        deleteAll: async () => {
          store.clear()
        },
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
        getAlarm: async () => undefined,
      },
      getWebSockets: () => [],
      waitUntil: (promise: Promise<unknown>) => void promise,
      id: { toString: () => "late-join-room" },
    } as never,
    { SFU_ROOM: {} } as never
  )
}

async function lateJoinControl(
  session: RoomSession,
  body: Record<string, unknown>
) {
  const response = await session.fetch(
    new Request("https://room/control", {
      method: "POST",
      body: JSON.stringify(body),
    })
  )
  return { status: response.status, json: await response.json() }
}

describe("RoomContent — Turnstile widget lifecycle", () => {
  let mock: ReturnType<typeof installMockTurnstile>

  beforeEach(() => {
    mock = installMockTurnstile()
    mockUseSfuChatRoom.mockReset()
    // jsdom doesn't implement scrollIntoView; TextChatCard calls it on
    // every message-list update.
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    delete (window as { turnstile?: unknown }).turnstile
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("removes the widget as soon as verification succeeds, and the connected room UI carries no Turnstile residue", async () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "verifying",
      participants: [],
    })

    const { rerender, container, queryByText } = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    // The pre-connect screen mounts the bounded Turnstile container.
    expect(queryByText(/verifying/i)).toBeInTheDocument()

    // Grab the real requestToken the component wired up to useSfuChatRoom,
    // and drive it the same way useSfuChatRoom would on a fresh join.
    const options = mockUseSfuChatRoom.mock.calls[0]?.[3] as {
      getTurnstileToken: () => Promise<string>
    }
    expect(options.getTurnstileToken).toBeInstanceOf(Function)

    let tokenPromise: Promise<string> | undefined
    act(() => {
      tokenPromise = options.getTurnstileToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    expect(mock.remove).not.toHaveBeenCalled()

    act(() => {
      mock.fireSuccess("token-1")
    })
    await expect(tokenPromise).resolves.toBe("token-1")

    // The widget must be torn down the moment the token settles — before the
    // component even transitions to the connected room UI.
    await waitFor(() => expect(mock.remove).toHaveBeenCalledTimes(1))

    // Now simulate useSfuChatRoom moving on to the connected room.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      participants: [
        {
          peerId: "local-peer",
          name: "tester",
          kind: "human",
          room: "test-room",
          muteState: false,
          audioStream: null,
          screenShareStream: null,
          screenShareEnabled: false,
        },
      ],
    })
    rerender(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    expect(queryByText(/verifying/i)).not.toBeInTheDocument()
    expect(queryByText(/joining/i)).not.toBeInTheDocument()
    // No second widget was ever rendered for the connected room, and nothing
    // further was removed — the one widget's lifecycle is fully accounted
    // for by the single success -> remove pair above.
    expect(mock.render).toHaveBeenCalledTimes(1)
    expect(mock.remove).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[id^="cf-chl-widget"]')).toBeNull()
  })

  it("switches between Room, T, and U without mirroring task text into Room", () => {
    const taskRequest = (
      requestId: string,
      summary: string,
      sequence: number
    ): Message => ({
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
        summary,
      },
    })
    const message = (
      taskRequestId: string,
      text: string,
      sequence: number
    ): Message => ({
      peerId: "agent-x",
      name: "Agent X",
      kind: "agent",
      type: "text",
      sequence,
      text,
      taskRequestId,
    })
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [
        {
          peerId: "human-local",
          name: "Hannah",
          kind: "human",
          type: "text",
          sequence: 1,
          text: "ROOM marker",
        },
        taskRequest("T", "Migration plan", 2),
        message("T", "T output", 3),
        taskRequest("U", "U marker", 4),
        message("U", "U output", 5),
      ],
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByText("ROOM marker")).toBeInTheDocument()
    expect(screen.queryByText("T output")).not.toBeInTheDocument()
    expect(screen.queryByText("U output")).not.toBeInTheDocument()

    const composer = screen.getByLabelText(
      "Message the room or @ an Agent"
    ) as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set
    setter!.call(composer, "Room draft must not follow a task")
    composer.dispatchEvent(new Event("input", { bubbles: true }))

    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    expect(screen.getByText("T output")).toBeInTheDocument()
    expect(screen.queryByText("ROOM marker")).not.toBeInTheDocument()
    expect(screen.queryByText("U output")).not.toBeInTheDocument()
    expect(
      (
        screen.getByLabelText(
          "Message the room or @ an Agent"
        ) as HTMLTextAreaElement
      ).value
    ).toBe("")

    fireEvent.click(screen.getByTestId("interaction-tab-task-U"))
    expect(screen.getByText("U output")).toBeInTheDocument()
    expect(screen.queryByText("T output")).not.toBeInTheDocument()
  })

  it("auto-opens an incoming task only once so Room can be selected again", async () => {
    const incomingTask: Message = {
      peerId: "agent-x",
      name: "Agent X",
      kind: "agent",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "incoming-task",
        kind: "request",
        fromParticipantId: "agent-x",
        targetParticipantId: "human-local",
        summary: "Incoming task",
      },
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [incomingTask],
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    await waitFor(() =>
      expect(
        screen.getByTestId("interaction-tab-task-incoming-task")
      ).toHaveAttribute("aria-selected", "true")
    )
    fireEvent.click(screen.getByTestId("interaction-tab-room"))
    expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await waitFor(() =>
      expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
        "aria-selected",
        "true"
      )
    )
  })

  it("keeps Task artifacts in their Task scope and avoids duplicate collab cards", () => {
    const task = (requestId: string, sequence: number): Message => ({
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
        attachmentIds: requestId === "T" ? ["task-artifact"] : undefined,
      },
    })
    const attachment = (id: string, taskRequestId?: string) => ({
      id,
      senderId: "agent-x",
      senderName: "Agent X",
      senderKind: "agent" as const,
      fileName: `${id}.txt`,
      mimeType: "text/plain" as const,
      size: 4,
      sequence: 10,
      createdAt: 10,
      ...(taskRequestId ? { taskRequestId } : {}),
    })
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [task("T", 1), task("U", 2)],
      attachments: [
        attachment("room-artifact"),
        attachment("task-artifact", "T"),
        attachment("other-artifact", "U"),
      ],
      participants: [
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
      ],
      localParticipantId: "human-local",
    })

    render(
      <RoomContent roomName="test-room" nickName="Hannah" roomType="audio" />
    )
    expect(screen.getByText("room-artifact.txt")).toBeInTheDocument()
    expect(screen.queryByText("task-artifact.txt")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("interaction-tab-task-T"))
    expect(
      screen.getByRole("button", { name: /View artifact/ })
    ).toBeInTheDocument()
    expect(screen.queryByText("task-artifact.txt")).not.toBeInTheDocument()
    expect(screen.queryByText("room-artifact.txt")).not.toBeInTheDocument()
    expect(screen.queryByText("other-artifact.txt")).not.toBeInTheDocument()
  })

  it("carries a persisted Task Live View from late Human registration to the selected Task", async () => {
    const store = new Map<string, unknown>([["room", lateJoinRoom()]])
    const publisher = lateJoinSession(store)
    const published = await lateJoinControl(publisher, {
      action: "agent-publish-live-view",
      participantId: "agent-a",
      token: "agent-a-token",
      taskRequestId: "late-join-task",
      surface: lateJoinSurface(),
    })
    expect(published.status).toBe(200)
    expect(store.has("task-live-view:late-join-task")).toBe(true)

    // A new Session models a late Human joining after the original DO has
    // persisted the canonical snapshot. This exercises the real register
    // response rather than seeding taskLiveViews directly into the browser.
    const lateHuman = lateJoinSession(store)
    const registered = await lateJoinControl(lateHuman, {
      action: "register",
      participant: {
        id: "human-b",
        name: "Human B",
        kind: "human",
        joinedAt: 2,
        token: "human-b-token",
        media: {
          sessionId: "late-human-session",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      },
    })
    expect(registered.status).toBe(200)

    const state = (registered.json as { state: RoomState }).state
    expect(state.taskLiveViews?.["late-join-task"]).toMatchObject({
      taskRequestId: "late-join-task",
      authorityAgentId: "agent-a",
      revision: 1,
    })

    // This is the browser's state-frame boundary: useSfuChatRoom receives
    // register's state and applies state.taskLiveViews before RoomContent
    // resolves the selected Task's snapshot.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: state.messages as Message[],
      participants: state.participants.map((participant) => ({
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        room: "test-room",
        muteState: false,
        screenShareEnabled: false,
        screenShareStream: null,
      })),
      taskLiveViews: state.taskLiveViews,
      localParticipantId: "human-b",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-b" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="Human B" roomType="audio" />
    )

    expect(
      screen.getByTestId("interaction-tab-task-late-join-task")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("interaction-tab-task-late-join-task"))
    expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
    expect(screen.getByText("Count")).toBeInTheDocument()
  })

  it("shows activity from every connected Agent in the active task", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-t",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-codex",
        summary: "Review this task",
      },
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [
        {
          peerId: "local-peer-id",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
        },
        {
          peerId: "agent-pi",
          name: "Pi",
          kind: "agent",
          room: "test-room",
        },
      ],
      agentActivities: [
        {
          agentParticipantId: "agent-codex",
          scopeId: "task:task-t",
          state: "responding",
        },
        {
          agentParticipantId: "agent-pi",
          scopeId: "task:task-t",
          state: "thinking",
        },
      ],
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    fireEvent.click(screen.getByTestId("interaction-tab-task-task-t"))
    const activity = screen.getByTestId("task-agent-activity")
    expect(activity).toHaveTextContent("Codex · Responding…")
    expect(activity).toHaveTextContent("Pi · Thinking…")
  })

  it("keeps the interaction shell bounded while Task activity is visible", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-layout",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-codex",
        summary: "Long-running task",
      },
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [
        {
          peerId: "local-peer-id",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
        },
      ],
      agentActivities: [
        {
          agentParticipantId: "agent-codex",
          scopeId: "task:task-layout",
          state: "using_tools",
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-layout"))

    expect(screen.getByTestId("interaction-tablist")).toHaveClass("flex-none")
    expect(screen.getByTestId("interaction-content")).toHaveClass(
      "flex",
      "min-h-0",
      "flex-1",
      "flex-col"
    )
    expect(screen.getByTestId("task-agent-activity")).toHaveClass("flex-none")
    expect(screen.getByTestId("interaction-chat")).toHaveClass(
      "min-h-0",
      "flex-1"
    )
  })

  it("marks a non-terminal Task unavailable and disables its composer", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-orphan",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-codex",
        summary: "Orphaned task",
      },
    }
    const accepted: Message = {
      peerId: "agent-codex",
      name: "Codex",
      kind: "agent",
      type: "action",
      actionType: "collab",
      sequence: 2,
      collab: {
        requestId: "task-orphan",
        kind: "accepted",
        fromParticipantId: "agent-codex",
        targetParticipantId: "human-local",
        summary: "working",
      },
    }
    const sendTextMessage = vi.fn()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest, accepted],
      sendTextMessage,
      participants: [
        {
          peerId: "local-peer-id",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    const { rerender } = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-orphan"))

    expect(screen.getByLabelText("Status Working")).toBeInTheDocument()
    expect(screen.getByLabelText("Task unavailable")).toBeInTheDocument()
    expect(screen.getByTestId("task-unavailable")).toHaveTextContent(
      "No participating Agent is currently available."
    )
    expect(
      screen.getByLabelText("Message the room or @ an Agent")
    ).toBeDisabled()
    expect(screen.getByLabelText("Send message")).toBeDisabled()
    expect(sendTextMessage).not.toHaveBeenCalled()

    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest, accepted],
      sendTextMessage,
      participants: [
        {
          peerId: "local-peer-id",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
        },
      ],
    })
    rerender(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    expect(screen.queryByTestId("task-unavailable")).toBeNull()
    expect(
      screen.getByLabelText("Message the room or @ an Agent")
    ).toBeEnabled()
  })

  it("keeps a Task available when a secondary participating Agent is connected", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-secondary",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-codex",
        summary: "Secondary Agent task",
      },
    }
    const secondaryTarget: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "text",
      sequence: 2,
      taskRequestId: "task-secondary",
      targets: ["agent-pi"],
      text: "Pi, continue this task",
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest, secondaryTarget],
      participants: [
        {
          peerId: "local-peer-id",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-pi",
          name: "Pi",
          kind: "agent",
          room: "test-room",
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-secondary"))

    expect(screen.getByLabelText("Status Starting")).toBeInTheDocument()
    expect(screen.queryByLabelText("Task unavailable")).toBeNull()
    expect(screen.queryByTestId("task-unavailable")).toBeNull()
    expect(
      screen.getByLabelText("Message the room or @ an Agent")
    ).toBeEnabled()
  })

  it("keeps terminal Task lifecycle status separate from availability", () => {
    const makeTask = (
      requestId: string,
      kind: "completed" | "failed"
    ): Message[] => [
      {
        peerId: "human-local",
        name: "Hannah",
        kind: "human",
        type: "action",
        actionType: "collab",
        sequence: kind === "completed" ? 1 : 3,
        collab: {
          requestId,
          kind: "request",
          fromParticipantId: "human-local",
          targetParticipantId: "agent-codex",
          summary: requestId,
        },
      },
      {
        peerId: "agent-codex",
        name: "Codex",
        kind: "agent",
        type: "action",
        actionType: "collab",
        sequence: kind === "completed" ? 2 : 4,
        collab: {
          requestId,
          kind,
          fromParticipantId: "agent-codex",
          targetParticipantId: "human-local",
          summary: kind,
        },
      },
    ]
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [
        ...makeTask("task-completed", "completed"),
        ...makeTask("task-failed", "failed"),
      ],
      participants: [
        {
          peerId: "local-peer-id",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    expect(screen.getByLabelText("Status Completed")).toBeInTheDocument()
    expect(screen.getByLabelText("Status Failed")).toBeInTheDocument()
    expect(screen.queryByLabelText("Task unavailable")).toBeNull()
  })

  it("copies the ordinary Agent invite only through the popover action, without a provider claim", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(trackAnalyticsEvent).mockClear()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    // Opening the popover copies NOTHING and emits NOTHING.
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    expect(screen.getByText("Invite an Agent")).toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy invite prompt" }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Join my temporary")
    )
    expect(writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("--provider-claim")
    )
    await waitFor(() =>
      expect(trackAnalyticsEvent).toHaveBeenCalledWith("AgentInviteCopied", {
        surface: "room",
        roomType: "audio",
      })
    )
    // Feedback stays inside the popover; the header button never becomes
    // "Copied!".
    expect(
      await screen.findByText(/✓ Invite prompt copied\./)
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull()
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
  })

  it("shows a retryable clipboard error inside the invite popover", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"))
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(trackAnalyticsEvent).mockClear()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy invite prompt" }))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Clipboard access was blocked. Try again."
    )
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
    )
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeEnabled()
  })

  it("uses the Room-wide Live Transcript control without replacing Agent Voice", () => {
    const startLiveTranscript = vi.fn()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: true,
      agentVoiceMediaAvailable: true,
      runtimeHosts: {
        "host-a": {
          runtimeHostId: "host-a",
          speech: { stt: true, tts: true },
        },
      },
      runtimeHostProviders: {
        "host-a": { humanParticipantId: "human-local", claimedAt: 1 },
      },
      startLiveTranscript,
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
          voiceAvailable: true,
          voiceEnabled: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // #236: one feature-first header control; Start lives inside its popover.
    fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(startLiveTranscript).toHaveBeenCalledWith("host-a")
    expect(screen.queryByText(/Meeting Notes/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Note-taker/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Enable voice for Codex" })
    ).toBeEnabled()
  })

  it("keeps the Room header to user goals — no Runtime plumbing labels (#236)", () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: false,
      agentVoiceMediaAvailable: false,
      runtimeHosts: {},
      runtimeHostProviders: {},
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // The toolbar exposes exactly the primary controls, and Live Transcript
    // appears once as a feature button — never as a status strip.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
    expect(
      screen.getAllByRole("button", { name: "Leave" }).length
    ).toBeGreaterThan(0)
    expect(screen.getAllByText("Live Transcript").length).toBeGreaterThan(0)
    expect(
      screen.queryByText("No transcription Runtime connected")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Connection command copied")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Connect local Runtime")).not.toBeInTheDocument()
  })

  describe("Room App Stage placement and residency", () => {
    class TestPort {
      onmessage: ((event: MessageEvent) => void) | null = null
      postMessage = vi.fn()
      start = vi.fn()
      close = vi.fn()

      emit(data: unknown) {
        this.onmessage?.({ data } as MessageEvent)
      }
    }

    let channels: { port1: TestPort; port2: TestPort }[] = []

    class TestMessageChannel {
      port1 = new TestPort()
      port2 = new TestPort()

      constructor() {
        channels.push(this)
      }
    }

    const localParticipant = {
      peerId: "local-peer",
      name: "Alice",
      kind: "human",
      room: "test-room",
      muteState: false,
    }

    const remoteScreenShare = {
      peerId: "publisher-a",
      name: "Bob",
      kind: "human",
      room: "test-room",
      screenShareEnabled: true,
      screenShareStream: {} as MediaStream,
    }

    function renderAppRoom(overrides: Record<string, unknown> = {}) {
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
        ...overrides,
      })
      return render(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
    }

    /** Loads an App iframe so the host really opens its MessagePort. */
    function loadAppIframe(iframe: HTMLIFrameElement) {
      const frameWindow = { postMessage: vi.fn() }
      Object.defineProperty(iframe, "contentWindow", { value: frameWindow })
      fireEvent.load(iframe)
      return frameWindow
    }

    /** Answers the bootstrap so the host forwards live App messages. */
    function completeHandshake(
      frameWindow: { postMessage: ReturnType<typeof vi.fn> },
      appId: string,
      port: TestPort
    ) {
      const bootstrap = frameWindow.postMessage.mock.calls[0][0]
      act(() => {
        port.emit({
          type: "ready",
          appInstanceId: roomAppInstanceId("test-room", appId),
          handshakeToken: bootstrap.handshakeToken,
        })
      })
    }

    const slot = (appId: string) => screen.getByTestId(`room-app-slot-${appId}`)
    const slotHidden = (appId: string) =>
      slot(appId).className.includes("hidden")
    const slotIframe = (appId: string) =>
      within(slot(appId)).getByTestId("room-app-iframe") as HTMLIFrameElement
    const slotHost = (appId: string) =>
      within(slot(appId)).getByTestId("room-app-host")

    beforeEach(() => {
      channels = []
      vi.stubGlobal("MessageChannel", TestMessageChannel)
    })

    it("mounts a first launch on the visual Stage while the Room conversation stays", async () => {
      renderAppRoom()

      // Nothing is resident before the first launch, and the Stage idles on
      // participants.
      expect(screen.queryByTestId("room-app-iframe")).toBeNull()
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
        "aria-selected",
        "true"
      )

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))

      const host = await screen.findByTestId("room-app-host")
      const stage = screen.getByTestId("room-stage")
      expect(stage.contains(host)).toBe(true)
      // Stage content, never conversation content: the same structure keeps it
      // out of the stacked mobile conversation pane.
      expect(host.closest(".room-participants-panel")).not.toBeNull()
      expect(host.closest(".room-chat-panel")).toBeNull()
      expect(screen.getByTestId("interaction-chat").contains(host)).toBe(false)
      // A Room App is a large visual surface, like screen share.
      expect(stage).toHaveStyle({ width: "75%" })
      expect(screen.queryByTestId("room-stage-participants")).toBeNull()

      // Room conversation remains selected and rendered beside the App.
      expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
        "aria-selected",
        "true"
      )
      expect(
        screen.getByPlaceholderText("Message the room or @ an Agent…")
      ).toBeInTheDocument()

      // One launch means one iframe and one MessagePort.
      expect(screen.getAllByTestId("room-app-iframe")).toHaveLength(1)
      const iframe = slotIframe("shared-canvas")
      expect(iframe).toHaveAttribute(
        "src",
        expect.stringContaining("/shared-canvas")
      )
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("keeps the resident App while the conversation switches between Room and Task", async () => {
      renderAppRoom({ messages: [taskRequestMessage] })

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      const host = await screen.findByTestId("room-app-host")

      fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
      expect(
        screen.getByTestId("interaction-tab-task-task-live")
      ).toHaveAttribute("aria-selected", "true")
      expect(screen.getByTestId("room-app-host")).toBe(host)

      fireEvent.click(screen.getByTestId("interaction-tab-room"))
      expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
        "aria-selected",
        "true"
      )
      expect(screen.getByTestId("room-app-host")).toBe(host)
      expect(
        screen.getByPlaceholderText("Message the room or @ an Agent…")
      ).toBeInTheDocument()
    })

    it("launches once and reuses the same iframe and MessagePort when hidden and shown again", async () => {
      const send = vi.fn(() => false)
      renderAppRoom({ sendRoomAppMessage: send })

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      const iframe = slotIframe("shared-canvas")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)

      // Hide by toggling the Stage entry off.
      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      expect(slotHidden("shared-canvas")).toBe(true)
      expect(slotIframe("shared-canvas")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      // Show it again: same host, same session, no new MessagePort.
      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      expect(slotHidden("shared-canvas")).toBe(false)
      expect(slotIframe("shared-canvas")).toBe(iframe)
      expect(channels).toHaveLength(1)
      expect(channels[0].port1.close).not.toHaveBeenCalled()
      // Visibility is presentation only: it never becomes host traffic.
      expect(send).not.toHaveBeenCalled()
    })

    it("treats visual Close as Hide and restores the same session on reopen", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))
      const iframe = slotIframe("tiny-arena")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)

      fireEvent.click(
        within(slotHost("tiny-arena")).getByRole("button", { name: "Close" })
      )

      // The Stage returns to participants; the session stays resident.
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(slotHidden("tiny-arena")).toBe(true)
      expect(slotIframe("tiny-arena")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))
      expect(slotHidden("tiny-arena")).toBe(false)
      expect(slotIframe("tiny-arena")).toBe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("keeps Canvas resident while Arena is shown and restores the same Canvas iframe", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      const canvasIframe = slotIframe("shared-canvas")
      loadAppIframe(canvasIframe)
      const canvasPort = channels[0].port1
      expect(channels).toHaveLength(1)

      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))

      expect(slotHidden("shared-canvas")).toBe(true)
      expect(slotHidden("tiny-arena")).toBe(false)
      // Both sessions exist; Canvas was hidden, not destroyed.
      expect(screen.getAllByTestId("room-app-iframe")).toHaveLength(2)
      expect(screen.getAllByTestId("room-app-host")).toHaveLength(2)
      expect(slotIframe("shared-canvas")).toBe(canvasIframe)
      expect(canvasPort.close).not.toHaveBeenCalled()

      const arenaIframe = slotIframe("tiny-arena")
      loadAppIframe(arenaIframe)
      expect(channels).toHaveLength(2)

      // Back to Canvas: the exact same iframe/port/App-local state.
      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      expect(slotHidden("shared-canvas")).toBe(false)
      expect(slotIframe("shared-canvas")).toBe(canvasIframe)
      expect(canvasPort.close).not.toHaveBeenCalled()
      expect(channels).toHaveLength(2)
      // Arena stays resident behind it.
      expect(slotHidden("tiny-arena")).toBe(true)
      expect(slotIframe("tiny-arena")).toBe(arenaIframe)
    })

    it("keeps both Humans' resident Canvas sessions when both hide and reopen", async () => {
      const humanHook = (name: string) => ({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [{ ...localParticipant, name }],
      })
      mockUseSfuChatRoom.mockImplementation((_room: unknown, nick: unknown) =>
        humanHook(nick === "Alice" ? "Alice" : "Bob")
      )
      const alice = render(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      const bob = render(
        <RoomContent roomName="test-room" nickName="Bob" roomType="audio" />
      )
      const aliceView = within(alice.container)
      const bobView = within(bob.container)

      fireEvent.click(aliceView.getByTestId("stage-app-shared-canvas"))
      fireEvent.click(bobView.getByTestId("stage-app-shared-canvas"))
      const aliceIframe = aliceView.getByTestId(
        "room-app-iframe"
      ) as HTMLIFrameElement
      const bobIframe = bobView.getByTestId(
        "room-app-iframe"
      ) as HTMLIFrameElement
      loadAppIframe(aliceIframe)
      loadAppIframe(bobIframe)
      expect(channels).toHaveLength(2)

      // Both Humans hide Canvas for this browser session.
      fireEvent.click(aliceView.getByTestId("stage-app-shared-canvas"))
      fireEvent.click(bobView.getByTestId("stage-app-shared-canvas"))
      expect(
        aliceView.getByTestId("room-app-slot-shared-canvas").className
      ).toContain("hidden")
      expect(
        bobView.getByTestId("room-app-slot-shared-canvas").className
      ).toContain("hidden")
      // Neither resident session was destroyed, so an incumbent Canvas can
      // still answer the bounded canonical bootstrap when it is reopened.
      for (const channel of channels)
        expect(channel.port1.close).not.toHaveBeenCalled()

      // Reopening restores the same iframes and sessions on both browsers.
      fireEvent.click(aliceView.getByTestId("stage-app-shared-canvas"))
      fireEvent.click(bobView.getByTestId("stage-app-shared-canvas"))
      expect(aliceView.getByTestId("room-app-iframe")).toBe(aliceIframe)
      expect(bobView.getByTestId("room-app-iframe")).toBe(bobIframe)
      expect(channels).toHaveLength(2)
    })

    it("keeps a hidden App's session live without adding outbound traffic", async () => {
      let listener: ((message: unknown) => void) | undefined
      const subscribe = vi.fn((next: (message: unknown) => void) => {
        listener = next
        return () => undefined
      })
      const send = vi.fn(() => true)
      renderAppRoom({
        subscribeRoomAppMessages: subscribe,
        sendRoomAppMessage: send,
      })

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      const frameWindow = loadAppIframe(slotIframe("shared-canvas"))
      completeHandshake(frameWindow, "shared-canvas", channels[0].port1)

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      expect(slotHidden("shared-canvas")).toBe(true)

      // A hidden resident App still receives the bounded logical messages it
      // needs to preserve and reconcile its own state.
      const payload = { type: "stroke", points: [[1, 2]] }
      act(() => {
        listener?.({
          protocolVersion: 1,
          appInstanceId: roomAppInstanceId("test-room", "shared-canvas"),
          lane: "reliable",
          sourceParticipantId: "other-human",
          payload,
        })
      })
      expect(channels[0].port1.postMessage).toHaveBeenCalledWith({
        type: "reliable",
        appInstanceId: roomAppInstanceId("test-room", "shared-canvas"),
        sourceParticipantId: "other-human",
        payload,
      })
      // Hiding is never host traffic: no heartbeat was introduced.
      expect(send).not.toHaveBeenCalled()
    })

    it("hides the App when the Stage switches back to Screen or Live View", async () => {
      renderAppRoom({
        resolvedRoomType: "screenshare",
        messages: [taskRequestMessage],
        participants: [localParticipant, remoteScreenShare],
        taskLiveViews: { "task-live": taskLiveViewSnapshot },
      })

      fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      const iframe = slotIframe("shared-canvas")
      loadAppIframe(iframe)

      fireEvent.click(screen.getByTestId("stage-view-live-view"))
      expect(slotHidden("shared-canvas")).toBe(true)
      expect(screen.getByTestId("task-live-view")).toBeInTheDocument()

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      expect(slotHidden("shared-canvas")).toBe(false)

      fireEvent.click(screen.getByTestId("stage-view-screen"))
      expect(slotHidden("shared-canvas")).toBe(true)
      expect(document.querySelector("video")).toBeInTheDocument()
      // The Task conversation scope is untouched by Stage switching, and the
      // App session survived both switches.
      expect(
        screen.getByTestId("interaction-tab-task-task-live")
      ).toHaveAttribute("aria-selected", "true")
      expect(slotIframe("shared-canvas")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()
    })

    it("offers Screen while an App is open even without a Task Live View", async () => {
      renderAppRoom({
        resolvedRoomType: "screenshare",
        participants: [localParticipant, remoteScreenShare],
      })

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      expect(await screen.findByTestId("room-app-host")).toBeInTheDocument()
      expect(screen.queryByTestId("stage-view-live-view")).toBeNull()

      // Screen is a Stage surface in its own right: it must stay reachable
      // while an App is open, with no Live View sharing the switcher.
      fireEvent.click(screen.getByTestId("stage-view-screen"))
      expect(slotHidden("shared-canvas")).toBe(true)
      expect(document.querySelector("video")).toBeInTheDocument()
    })

    it("offers Live View while an App is open even without a screen share", async () => {
      renderAppRoom({
        messages: [taskRequestMessage],
        taskLiveViews: { "task-live": taskLiveViewSnapshot },
      })

      fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))
      expect(await screen.findByTestId("room-app-host")).toBeInTheDocument()
      expect(screen.queryByTestId("stage-view-screen")).toBeNull()

      // Live View is likewise reachable on its own availability.
      fireEvent.click(screen.getByTestId("stage-view-live-view"))
      expect(slotHidden("tiny-arena")).toBe(true)
      expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
    })

    it("keeps hidden App slots non-interactive", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))

      // display:none removes the hidden host from hit-testing and tab order;
      // inert + aria-hidden state the intent explicitly.
      const hidden = slot("shared-canvas")
      expect(hidden.className).toContain("hidden")
      expect(hidden).toHaveAttribute("aria-hidden", "true")
      expect(hidden).toHaveAttribute("inert")

      const visible = slot("tiny-arena")
      expect(visible.className).not.toContain("hidden")
      expect(visible).toHaveAttribute("aria-hidden", "false")
      expect(visible).not.toHaveAttribute("inert")
    })

    it("tears resident hosts down when the catalog removes them", async () => {
      const view = renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))
      loadAppIframe(slotIframe("shared-canvas"))
      loadAppIframe(slotIframe("tiny-arena"))
      expect(channels).toHaveLength(2)

      // ROOM_APPS_ENABLED off / catalog entry gone.
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: false,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )

      await waitFor(() =>
        expect(screen.queryByTestId("room-app-slot-shared-canvas")).toBeNull()
      )
      expect(screen.queryByTestId("room-app-slot-tiny-arena")).toBeNull()
      expect(channels[0].port1.close).toHaveBeenCalledTimes(1)
      expect(channels[1].port1.close).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
    })

    it("closes every resident MessagePort exactly once when the Room unmounts", async () => {
      const view = renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-shared-canvas"))
      fireEvent.click(screen.getByTestId("stage-app-tiny-arena"))
      loadAppIframe(slotIframe("shared-canvas"))
      loadAppIframe(slotIframe("tiny-arena"))
      expect(channels).toHaveLength(2)

      view.unmount()

      expect(channels[0].port1.close).toHaveBeenCalledTimes(1)
      expect(channels[1].port1.close).toHaveBeenCalledTimes(1)
    })
  })

  it("uses the intentional two-row mobile header layout with a truncating Room id", () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: false,
      agentVoiceMediaAvailable: false,
      runtimeHosts: {},
      runtimeHostProviders: {},
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // Row 1: Room identity (truncating, min-width-safe container) plus the
    // Leave lifecycle action on the same row.
    const identity = within(screen.getByTestId("room-header-identity"))
    expect(identity.getByText("#test-room")).toBeTruthy()
    expect(identity.getByRole("button", { name: "Leave" })).toBeTruthy()

    // Row 2: exactly the three feature actions. No plumbing labels.
    const features = within(screen.getByTestId("room-header-features"))
    expect(features.getByRole("button", { name: "Copy link" })).toBeTruthy()
    expect(features.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
    expect(
      features.getByRole("button", { name: "Live Transcript" })
    ).toBeTruthy()
    expect(
      screen.queryByText("No transcription Runtime connected")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Connect local Runtime")).not.toBeInTheDocument()
  })

  it("opens the Invite Agent popover from the Live Transcript setup copy", () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: false,
      agentVoiceMediaAvailable: false,
      runtimeHosts: {},
      runtimeHostProviders: {},
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // Unavailable Live Transcript setup copy points new Humans at the
    // Agent-first path. Cross-opening is one-feature-at-a-time: the Live
    // Transcript dialog closes FIRST, then the Invite Agent dialog opens.
    fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
    expect(
      screen.getByRole("dialog", { name: "Live Transcript" })
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Start with Invite Agent" })
    )
    expect(
      screen.queryByRole("dialog", { name: "Live Transcript" })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("dialog", { name: "Invite an Agent" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Copy invite prompt" })
    ).toBeTruthy()
  })

  it("keeps participant cards free of personal reaction quick controls", () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
        },
      ],
    })

    const { container } = render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    expect(container.querySelector(".room-reactions")).toBeNull()
    for (const emoji of ["👍", "😂", "🔥", "❓"])
      expect(screen.queryByRole("button", { name: emoji })).toBeNull()
  })

  it("emits LiveTranscriptStarted only on actual Start, never on popover open", () => {
    vi.mocked(trackAnalyticsEvent).mockClear()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: true,
      agentVoiceMediaAvailable: true,
      runtimeHosts: {
        "host-a": {
          runtimeHostId: "host-a",
          speech: { stt: true, tts: true },
        },
      },
      runtimeHostProviders: {
        "host-a": { humanParticipantId: "human-local", claimedAt: 1 },
      },
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // Opening the popover and viewing readiness emits nothing.
    fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "LiveTranscriptStarted",
      expect.anything()
    )

    // Actual Start emits exactly the existing event.
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(trackAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(trackAnalyticsEvent).toHaveBeenCalledWith("LiveTranscriptStarted", {
      roomType: "audio",
    })
  })

  it("switches the active preview between two remote screen shares", async () => {
    const streamA = {} as MediaStream
    const streamB = {} as MediaStream
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      resolvedRoomType: "screenshare",
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
          screenShareEnabled: false,
          screenShareStream: null,
        },
        {
          peerId: "publisher-a",
          name: "Bob",
          kind: "human",
          room: "test-room",
          screenShareEnabled: true,
          screenShareStream: streamA,
        },
        {
          peerId: "publisher-b",
          name: "Carol",
          kind: "human",
          room: "test-room",
          screenShareEnabled: true,
          screenShareStream: streamB,
        },
      ],
    })

    render(
      <RoomContent
        roomName="test-room"
        nickName="Alice"
        roomType="screenshare"
      />
    )

    const preview = () => document.querySelector("video") as HTMLVideoElement
    await waitFor(() => expect(preview().srcObject).toBe(streamA))
    fireEvent.click(screen.getByText("Carol"))
    await waitFor(() => expect(preview().srcObject).toBe(streamB))
  })

  it("shows a Task Live View beside screen share without touching media", async () => {
    const stream = {} as MediaStream
    const taskRequest: Message = {
      peerId: "local-peer",
      name: "Alice",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-live",
        kind: "request",
        fromParticipantId: "local-peer",
        targetParticipantId: "agent-a",
        summary: "Counter",
      },
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      resolvedRoomType: "screenshare",
      messages: [taskRequest],
      participants: [
        {
          peerId: "local-peer",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
          screenShareEnabled: false,
          screenShareStream: null,
        },
        {
          peerId: "publisher-a",
          name: "Bob",
          kind: "human",
          room: "test-room",
          screenShareEnabled: true,
          screenShareStream: stream,
        },
      ],
      taskLiveViews: {
        "task-live": {
          taskRequestId: "task-live",
          surfaceId: "counter",
          authorityAgentId: "agent-a",
          revision: 1,
          root: {
            type: "Column",
            children: [
              { type: "Text", text: "Count" },
              { type: "Value", path: "count" },
              {
                type: "Button",
                label: "+1",
                action: { type: "increment", path: "count", amount: 1 },
              },
              { type: "Input", path: "query", placeholder: "Filter" },
            ],
          },
          data: { count: 0, query: "initial" },
        },
      },
    })

    render(
      <RoomContent
        roomName="test-room"
        nickName="Alice"
        roomType="screenshare"
      />
    )
    vi.mocked(trackAnalyticsEvent).mockClear()
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
    expect(screen.getByTestId("stage-switcher")).toBeInTheDocument()
    expect(screen.queryByTestId("task-live-view")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Live View" }))
    expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
    await waitFor(() => {
      expect(
        vi
          .mocked(trackAnalyticsEvent)
          .mock.calls.filter(([name]) => name === "LiveViewVisible")
      ).toHaveLength(1)
    })
    fireEvent.change(screen.getByPlaceholderText("Filter"), {
      target: { value: "first" },
    })
    fireEvent.change(screen.getByPlaceholderText("Filter"), {
      target: { value: "second" },
    })
    expect(
      vi
        .mocked(trackAnalyticsEvent)
        .mock.calls.filter(([name]) => name === "LiveViewInteracted")
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "+1" }))
    fireEvent.click(screen.getByRole("button", { name: "+1" }))
    expect(
      vi
        .mocked(trackAnalyticsEvent)
        .mock.calls.filter(([name]) => name === "LiveViewInteracted")
    ).toHaveLength(1)
    for (const call of vi
      .mocked(trackAnalyticsEvent)
      .mock.calls.filter(([name]) =>
        ["LiveViewVisible", "LiveViewInteracted"].includes(name)
      )) {
      expect(call).toHaveLength(1)
      expect(JSON.stringify(call)).not.toContain("task-live")
      expect(JSON.stringify(call)).not.toContain("agent-a")
    }
    expect(document.querySelector("video")).toBeInTheDocument()
    expect(baseHookReturn.toggleScreenShare).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Screen" }))
    expect(screen.queryByTestId("task-live-view")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Live View" }))
    expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
    expect(
      vi
        .mocked(trackAnalyticsEvent)
        .mock.calls.filter(([name]) => name === "LiveViewVisible")
    ).toHaveLength(1)
    expect(document.querySelector("video")).toBeInTheDocument()
  })
})
