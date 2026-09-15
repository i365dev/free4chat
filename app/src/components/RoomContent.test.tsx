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
import {
  EMPTY_ROOM_APP_CATALOG,
  ROOM_APP_CATALOG_REFRESH_INTERVAL_MS,
  ROOM_APP_MAX_INSTANCES,
  parseRoomAppCatalog,
  roomAppInstanceId,
  setProductionRoomAppCatalog,
} from "../common/roomApp"
import * as roomAppModule from "../common/roomApp"
import type { RoomAppTransportEnvelope } from "../common/roomApp"
import { RoomSession } from "../do/RoomSession"
import type { RoomRecord, RoomState } from "../room/types"

const TEST_ROOM_APP_CATALOG = Array.from({ length: 10 }, (_, index) => {
  const id = `test-app-${index + 1}`
  return {
    id,
    label: `Test App ${index + 1}`,
    url: `https://room-apps.free4.chat/${id}`,
    origin: "https://room-apps.free4.chat",
  }
})
const TEST_ROOM_APP_CATALOG_RESPONSE = {
  version: 1,
  apps: TEST_ROOM_APP_CATALOG.map(({ id, label }) => ({
    id,
    label,
    path: `/${id}`,
    status: "active",
  })),
}

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
  sendRoomAppUnicast: vi.fn(() => "delivery_unavailable"),
  subscribeRoomAppUnicast: vi.fn(() => () => undefined),
  subscribeRoomAppUnicastResults: vi.fn(() => () => undefined),
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
    vi.stubEnv("NODE_ENV", "test")
    mock = installMockTurnstile()
    mockUseSfuChatRoom.mockReset()
    mockUseSfuChatRoom.mockReturnValue(baseHookReturn)
    setProductionRoomAppCatalog(TEST_ROOM_APP_CATALOG)
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(TEST_ROOM_APP_CATALOG_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    )
    // jsdom doesn't implement scrollIntoView; TextChatCard calls it on
    // every message-list update.
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    delete (window as { turnstile?: unknown }).turnstile
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    vi.unstubAllEnvs()
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

    /** jsdom has no WebRTC stack; a stream-shaped stub is enough for binding. */
    const remoteAudioStream = {
      id: "bob-room-audio",
      getAudioTracks: () => [],
    } as unknown as MediaStream
    const remoteSpeaker = {
      peerId: "peer-bob",
      name: "Bob",
      kind: "human",
      room: "test-room",
      muteState: false,
      audioStream: remoteAudioStream,
    }

    /** The Room-level playback element for a remote participant. */
    const audioSink = (peerId: string) =>
      document.querySelector<HTMLAudioElement>(
        `[data-testid="room-audio-sink"][data-peer-id="${peerId}"]`
      )

    const newlyCuratedApps = TEST_ROOM_APP_CATALOG.slice(3)

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

    /** Launches a curated App and completes its iframe handshake. */
    function launchAndHandshake(appId: string) {
      fireEvent.click(screen.getByTestId(`stage-app-${appId}`))
      const iframe = slotIframe(appId)
      const frameWindow = loadAppIframe(iframe)
      const port = channels[channels.length - 1].port1
      completeHandshake(frameWindow, appId, port)
      return { iframe, frameWindow, port }
    }

    /**
     * One Lab catalog revision, optionally with Apps relabeled or removed.
     * `parseRoomAppCatalog` is the same parser the browser loader runs on every
     * refresh, so mocked revisions reach RoomContent as brand-new objects.
     */
    function catalogRevision({
      relabel,
      remove,
    }: { relabel?: Record<string, string>; remove?: string[] } = {}) {
      const revision = parseRoomAppCatalog({
        version: 1,
        apps: TEST_ROOM_APP_CATALOG_RESPONSE.apps
          .filter((entry) => !remove?.includes(entry.id))
          .map((entry) => ({
            ...entry,
            label: relabel?.[entry.id] ?? entry.label,
          })),
      })
      if (!revision) throw new Error("the fixture catalog must parse")
      return revision
    }

    it("keeps Room copy generic and copies an App invite from fullscreen host chrome", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )

      await waitFor(() =>
        expect(screen.getByTestId("stage-app-test-app-1")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      )
      const iframe = slotIframe("test-app-1")
      const host = slotHost("test-app-1")
      const frameWindow = loadAppIframe(iframe)
      const port = channels[0].port1
      completeHandshake(frameWindow, "test-app-1", port)

      vi.mocked(trackAnalyticsEvent).mockClear()
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room`
      )
      expect(trackAnalyticsEvent).toHaveBeenLastCalledWith("InviteLinkCopied", {
        surface: "room",
        roomType: "audio",
      })

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))
      expect(host).toHaveAttribute("data-layout", "fullscreen")
      fireEvent.click(
        within(host).getByRole("button", { name: "Invite to this activity" })
      )
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room&app=test-app-1`
      )
      expect(trackAnalyticsEvent).toHaveBeenLastCalledWith("InviteLinkCopied", {
        surface: "room_app",
        roomType: "audio",
        app: "test-app-1",
      })
      expect(await within(host).findByText("Copied!")).toBeInTheDocument()
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(slotHost("test-app-1")).toBe(host)
      expect(channels[0].port1).toBe(port)
      expect(port.close).not.toHaveBeenCalled()
    })

    it("opens a directly addressed Lab App and preserves screenshare in its invite", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        resolvedRoomType: "screenshare",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="screenshare"
          initialRoomAppId="test-app-2"
        />
      )

      await waitFor(() =>
        expect(screen.getByTestId("stage-app-test-app-2")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      )
      const host = slotHost("test-app-2")
      const iframe = slotIframe("test-app-2")
      expect(iframe).toHaveAttribute(
        "src",
        "https://room-apps.free4.chat/test-app-2"
      )
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts")
      const frameWindow = loadAppIframe(iframe)
      const port = channels[0].port1
      completeHandshake(frameWindow, "test-app-2", port)
      await within(host).findByText("ready")
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "ready",
          appInstanceId: roomAppInstanceId("test-room", "test-app-2"),
        })
      )

      fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room&type=screenshare`
      )

      fireEvent.click(
        within(slotHost("test-app-2")).getByRole("button", {
          name: "Invite to this activity",
        })
      )
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room&type=screenshare&app=test-app-2`
      )
    })

    it("opens another directly addressed Lab App through the host and invite", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        resolvedRoomType: "screenshare",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="screenshare"
          initialRoomAppId="test-app-3"
        />
      )

      await waitFor(() =>
        expect(screen.getByTestId("stage-app-test-app-3")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      )
      expect(screen.getByTestId("stage-app-test-app-1")).toBeInTheDocument()
      expect(screen.getByTestId("stage-app-test-app-2")).toBeInTheDocument()
      const host = slotHost("test-app-3")
      const iframe = slotIframe("test-app-3")
      expect(iframe).toHaveAttribute(
        "src",
        "https://room-apps.free4.chat/test-app-3"
      )
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts")
      const frameWindow = loadAppIframe(iframe)
      const port = channels[0].port1
      completeHandshake(frameWindow, "test-app-3", port)
      await within(host).findByText("ready")

      fireEvent.click(
        within(host).getByRole("button", { name: "Invite to this activity" })
      )
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room&type=screenshare&app=test-app-3`
      )
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "ready",
          appInstanceId: roomAppInstanceId("test-room", "test-app-3"),
        })
      )
    })

    it.each(newlyCuratedApps)(
      "direct-launches $id with the curated sandbox, handshake and screenshare invite",
      async ({ id, url }) => {
        vi.stubEnv("NODE_ENV", "production")
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.assign(navigator, { clipboard: { writeText } })
        mockUseSfuChatRoom.mockReturnValue({
          ...baseHookReturn,
          connectionStatus: "connected",
          resolvedRoomType: "screenshare",
          roomAppsEnabled: true,
          participants: [localParticipant],
        })

        render(
          <RoomContent
            roomName="test-room"
            nickName="Alice"
            roomType="screenshare"
            initialRoomAppId={id}
          />
        )

        await waitFor(() =>
          expect(screen.getByTestId(`stage-app-${id}`)).toHaveAttribute(
            "aria-pressed",
            "true"
          )
        )
        const expectedStageIds = TEST_ROOM_APP_CATALOG.map((app) => app.id)
        for (const stageId of expectedStageIds)
          expect(screen.getByTestId(`stage-app-${stageId}`)).toBeInTheDocument()

        const host = slotHost(id)
        const iframe = slotIframe(id)
        expect(iframe).toHaveAttribute("src", url)
        expect(iframe).toHaveAttribute("sandbox", "allow-scripts")
        const frameWindow = loadAppIframe(iframe)
        const port = channels[0].port1
        completeHandshake(frameWindow, id, port)
        await within(host).findByText("ready")
        expect(port.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "ready",
            appInstanceId: roomAppInstanceId("test-room", id),
          })
        )

        fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
        expect(writeText).toHaveBeenLastCalledWith(
          `${window.location.origin}/room?id=test-room&type=screenshare`
        )

        fireEvent.click(
          within(host).getByRole("button", { name: "Invite to this activity" })
        )
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
        expect(writeText).toHaveBeenLastCalledWith(
          `${window.location.origin}/room?id=test-room&type=screenshare&app=${id}`
        )
      }
    )

    it("shows the full supplied catalog while keeping only two App hosts resident", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()

      const stageIds = TEST_ROOM_APP_CATALOG.map((app) => app.id)
      // The picker must expose the whole supplied catalog, and that catalog must
      // stay larger than the residency bound for the bound to mean anything.
      expect(stageIds.length).toBeGreaterThan(ROOM_APP_MAX_INSTANCES)
      for (const app of TEST_ROOM_APP_CATALOG) {
        const button = await screen.findByTestId(`stage-app-${app.id}`)
        expect(button).toBeInTheDocument()
        // The user-visible label comes from the Lab definition, without a badge.
        expect(button.textContent).toBe(app.label)
      }

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-4"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-6"))

      expect(screen.getAllByTestId("room-app-iframe")).toHaveLength(
        ROOM_APP_MAX_INSTANCES
      )
      expect(screen.queryByTestId("room-app-slot-test-app-1")).toBeNull()
      expect(screen.getByTestId("room-app-slot-test-app-4")).toBeInTheDocument()
      expect(screen.getByTestId("room-app-slot-test-app-6")).toBeInTheDocument()
      for (const id of stageIds)
        expect(screen.getByTestId(`stage-app-${id}`)).toBeInTheDocument()
    })

    it("refreshes the Lab catalog during a long-lived Room and retires removed Apps", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce(TEST_ROOM_APP_CATALOG)
        .mockResolvedValue([])
      let view: ReturnType<typeof render> | undefined
      try {
        view = renderAppRoom()
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        expect(screen.getByTestId("stage-app-test-app-1")).toBeInTheDocument()
        expect(catalogLoader).toHaveBeenCalledTimes(1)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        expect(screen.queryByTestId("stage-app-test-app-1")).toBeNull()
        expect(screen.queryByTestId("room-app-slot-test-app-1")).toBeNull()
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })

    it("keeps a resident App's host transport across an identical catalog refresh", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const appInstanceId = roomAppInstanceId("test-room", "test-app-1")
      const sendRoomAppMessage = vi.fn(() => true)
      let incoming: ((message: RoomAppTransportEnvelope) => void) | undefined
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce(TEST_ROOM_APP_CATALOG)
        .mockImplementation(async () => catalogRevision())
      let view: ReturnType<typeof render> | undefined
      try {
        view = renderAppRoom({
          sendRoomAppMessage,
          subscribeRoomAppMessages: (
            listener: (message: RoomAppTransportEnvelope) => void
          ) => {
            incoming = listener
            return () => undefined
          },
        })
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        const { iframe, frameWindow, port } = launchAndHandshake("test-app-1")
        expect(
          within(slotHost("test-app-1")).getByText("ready")
        ).toBeInTheDocument()

        // The 60s refresh returns the same logical Lab catalog.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        // The resident iframe and its MessagePort are the same objects: the
        // catalog refresh is metadata, not a transport reset.
        expect(slotIframe("test-app-1")).toBe(iframe)
        expect(channels).toHaveLength(1)
        expect(channels[0].port1).toBe(port)
        expect(port.close).not.toHaveBeenCalled()
        expect(frameWindow.postMessage).toHaveBeenCalledTimes(1)
        expect(
          within(slotHost("test-app-1")).getByText("ready")
        ).toBeInTheDocument()

        // App → host still reaches the Room transport.
        act(() => {
          port.emit({
            type: "sendReliable",
            appInstanceId,
            payload: { type: "tick", at: 1 },
          })
        })
        expect(sendRoomAppMessage).toHaveBeenCalledWith(
          "reliable",
          appInstanceId,
          { type: "tick", at: 1 }
        )

        // host → App still delivers a remote reliable message into the iframe.
        act(() => {
          incoming?.({
            protocolVersion: 1,
            appInstanceId,
            lane: "reliable",
            sourceParticipantId: "human-b",
            payload: { type: "tick", at: 2 },
          })
        })
        expect(port.postMessage).toHaveBeenCalledWith({
          type: "reliable",
          appInstanceId,
          sourceParticipantId: "human-b",
          payload: { type: "tick", at: 2 },
        })
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })

    it("applies a metadata-only catalog refresh without resetting a resident App", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const sendRoomAppMessage = vi.fn(() => true)
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce(TEST_ROOM_APP_CATALOG)
        .mockImplementation(async () =>
          catalogRevision({ relabel: { "test-app-1": "Test App 1 renamed" } })
        )
      let view: ReturnType<typeof render> | undefined
      try {
        view = renderAppRoom({ sendRoomAppMessage })
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        const { iframe, port } = launchAndHandshake("test-app-1")

        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        // The new metadata reaches the UI...
        expect(screen.getByTestId("stage-app-test-app-1").textContent).toBe(
          "Test App 1 renamed"
        )
        expect(
          within(slotHost("test-app-1")).getByText("Test App 1 renamed")
        ).toBeInTheDocument()
        // ...without touching the resident transport.
        expect(slotIframe("test-app-1")).toBe(iframe)
        expect(channels).toHaveLength(1)
        expect(channels[0].port1).toBe(port)
        expect(port.close).not.toHaveBeenCalled()

        act(() => {
          port.emit({
            type: "sendReliable",
            appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
            payload: { type: "tick", at: 3 },
          })
        })
        expect(sendRoomAppMessage).toHaveBeenCalledWith(
          "reliable",
          roomAppInstanceId("test-room", "test-app-1"),
          { type: "tick", at: 3 }
        )
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })

    it("retires a catalog-removed resident App exactly once", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce(TEST_ROOM_APP_CATALOG)
        .mockImplementation(async () =>
          catalogRevision({ remove: ["test-app-1"] })
        )
      let view: ReturnType<typeof render> | undefined
      try {
        view = renderAppRoom()
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        const { port } = launchAndHandshake("test-app-1")
        expect(port.close).not.toHaveBeenCalled()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        expect(screen.queryByTestId("room-app-slot-test-app-1")).toBeNull()
        expect(screen.queryByTestId("room-app-iframe")).toBeNull()
        expect(port.close).toHaveBeenCalledTimes(1)

        // A later refresh must not close the retired port a second time.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })
        expect(catalogLoader).toHaveBeenCalledTimes(3)
        expect(port.close).toHaveBeenCalledTimes(1)
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })

    it("retries a direct App launch after the first catalog response is empty", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce([])
        .mockResolvedValue(TEST_ROOM_APP_CATALOG)
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })
      let view: ReturnType<typeof render> | undefined
      try {
        view = render(
          <RoomContent
            roomName="test-room"
            nickName="Alice"
            roomType="audio"
            initialRoomAppId="test-app-1"
          />
        )
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        expect(catalogLoader).toHaveBeenCalledTimes(1)
        expect(screen.queryByTestId("room-app-iframe")).toBeNull()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        expect(screen.getByTestId("stage-app-test-app-1")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
        expect(screen.getByTestId("room-app-iframe")).toHaveAttribute(
          "src",
          "https://room-apps.free4.chat/test-app-1"
        )
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })

    it("loads and direct-launches the Lab catalog in development after an empty start", async () => {
      vi.stubEnv("NODE_ENV", "development")
      setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )

      const appButton = await screen.findByTestId("stage-app-test-app-1")
      await waitFor(() =>
        expect(appButton).toHaveAttribute("aria-pressed", "true")
      )
      expect(slotIframe("test-app-1")).toHaveAttribute(
        "src",
        "https://room-apps.free4.chat/test-app-1"
      )
    })

    it("exposes dynamically supplied Apps with their Lab-provided labels", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()

      for (const { id, label } of TEST_ROOM_APP_CATALOG.slice(7)) {
        const button = await screen.findByTestId(`stage-app-${id}`)
        expect(button.textContent).toBe(label)
      }
    })

    it("keeps copied ordinary Room links unchanged", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        participants: [localParticipant],
      })

      render(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }))

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/room?id=test-room`
        )
      )
    })

    it("keeps an ordinary Room usable when the initial App id is invalid", async () => {
      vi.stubEnv("NODE_ENV", "production")
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="unallowlisted-app"
        />
      )

      expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
        "aria-selected",
        "true"
      )
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(screen.getByTestId("interaction-chat")).toBeInTheDocument()
      expect(screen.queryByTestId("room-app-iframe")).toBeNull()
    })

    it("keeps a mounted App session intact when clipboard writing fails", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"))
      Object.assign(navigator, { clipboard: { writeText } })
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )
      await waitFor(() =>
        expect(screen.getByTestId("stage-app-test-app-1")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      )
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      const port = channels[0].port1
      vi.mocked(trackAnalyticsEvent).mockClear()

      fireEvent.click(
        within(slotHost("test-app-1")).getByRole("button", {
          name: "Invite to this activity",
        })
      )
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))

      expect(within(slotHost("test-app-1")).queryByText("Copied!")).toBeNull()
      expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
        "InviteLinkCopied",
        expect.anything()
      )
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1).toBe(port)
      expect(port.close).not.toHaveBeenCalled()
    })

    it("preserves screenshare type in the App invite while Room copy stays generic", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        resolvedRoomType: "screenshare",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })

      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="screenshare"
          initialRoomAppId="test-app-1"
        />
      )
      await waitFor(() =>
        expect(screen.getByTestId("stage-app-test-app-1")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      )

      fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room&type=screenshare`
      )
      fireEvent.click(
        within(slotHost("test-app-1")).getByRole("button", {
          name: "Invite to this activity",
        })
      )
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
      expect(writeText).toHaveBeenLastCalledWith(
        `${window.location.origin}/room?id=test-room&type=screenshare&app=test-app-1`
      )
    })

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

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))

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
      const iframe = slotIframe("test-app-1")
      expect(iframe).toHaveAttribute(
        "src",
        expect.stringContaining("/test-app-1")
      )
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("keeps the resident App while the conversation switches between Room and Task", async () => {
      renderAppRoom({ messages: [taskRequestMessage] })

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
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

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)

      // Hide by toggling the Stage entry off.
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(slotHidden("test-app-1")).toBe(true)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      // Show it again: same host, same session, no new MessagePort.
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(slotHidden("test-app-1")).toBe(false)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels).toHaveLength(1)
      expect(channels[0].port1.close).not.toHaveBeenCalled()
      // Visibility is presentation only: it never becomes host traffic.
      expect(send).not.toHaveBeenCalled()
    })

    it("keeps remote Room voice playing while a Room App is visible", () => {
      renderAppRoom({ participants: [localParticipant, remoteSpeaker] })

      const sink = audioSink("peer-bob")
      expect(sink).not.toBeNull()
      expect(sink!.srcObject).toBe(remoteAudioStream)
      expect(sink!.muted).toBe(false)
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()

      // The Room App takes the Stage; the visual participant surface goes away.
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(screen.getByTestId("room-app-iframe")).toBeInTheDocument()
      expect(screen.queryByTestId("room-stage-participants")).toBeNull()

      // Remote voice is ambient Room state, not a Stage surface: the very same
      // playback element keeps playing the same remote stream.
      expect(audioSink("peer-bob")).toBe(sink)
      expect(sink!.srcObject).toBe(remoteAudioStream)
      expect(sink!.muted).toBe(false)
    })

    it("does not recreate remote Room voice across App hide and reopen", () => {
      renderAppRoom({ participants: [localParticipant, remoteSpeaker] })
      const sink = audioSink("peer-bob")!

      // A Room App replaces the visible participant surface...
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(audioSink("peer-bob")).toBe(sink)

      // ...is hidden again...
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(audioSink("peer-bob")).toBe(sink)

      // ...and reopened.
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(audioSink("peer-bob")).toBe(sink)
      expect(audioSink("peer-bob")!.srcObject).toBe(remoteAudioStream)
      // One playback element per remote participant, never one per surface.
      expect(document.querySelectorAll("audio")).toHaveLength(1)
    })

    it("keeps remote Room voice when a screen share owns the Stage", () => {
      renderAppRoom({
        participants: [localParticipant, remoteSpeaker, remoteScreenShare],
      })
      const sink = audioSink("peer-bob")!

      // The screen-share branch renders the compact participant strip instead
      // of the presence grid; playback ownership must not follow that layout.
      fireEvent.click(screen.getByTestId("stage-view-screen"))
      expect(audioSink("peer-bob")).toBe(sink)
      expect(sink.srcObject).toBe(remoteAudioStream)

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(audioSink("peer-bob")).toBe(sink)
      expect(
        document.querySelectorAll(
          '[data-testid="room-audio-sink"][data-peer-id="peer-bob"]'
        )
      ).toHaveLength(1)
    })

    it("keeps remote Room voice through Room App fullscreen", () => {
      renderAppRoom({ participants: [localParticipant, remoteSpeaker] })
      const sink = audioSink("peer-bob")!

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const host = slotHost("test-app-1")

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))
      expect(host).toHaveAttribute("data-layout", "fullscreen")
      expect(audioSink("peer-bob")).toBe(sink)
      expect(sink.srcObject).toBe(remoteAudioStream)

      fireEvent.click(
        within(host).getByRole("button", { name: "Exit fullscreen" })
      )
      expect(host).toHaveAttribute("data-layout", "stage")
      expect(audioSink("peer-bob")).toBe(sink)
      expect(sink.muted).toBe(false)
    })

    it("has exactly one audible playback owner per remote participant", () => {
      renderAppRoom({ participants: [localParticipant, remoteSpeaker] })

      // The visible participant cards own no audible element at all, so the
      // Room-level sink can never double-play a remote participant.
      const grid = screen.getByTestId("room-stage-participants")
      expect(grid.querySelectorAll("audio")).toHaveLength(0)
      expect(within(grid).getByText(/Bob/)).toBeInTheDocument()
      expect(document.querySelectorAll("audio")).toHaveLength(1)
      expect(
        document.querySelectorAll('[data-testid="room-audio-sink"]')
      ).toHaveLength(1)
      // The local microphone is never played back into the Room.
      expect(audioSink("local-peer")).toBeNull()
    })

    it("uses a generic fullscreen layout without replacing the resident host", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      const host = slotHost("test-app-1")
      const port = channels[0].port1
      const chatPanel = screen
        .getByTestId("interaction-chat")
        .closest(".room-chat-panel")
      const composer = screen.getByPlaceholderText(
        "Message the room or @ an Agent…"
      )
      const stage = screen.getByTestId("room-stage")
      const roomShell = screen.getByRole("main")
      const roomHeader = screen
        .getByTestId("room-header-identity")
        .closest("header")
      expect(host).toHaveAttribute("data-layout", "stage")
      expect(chatPanel).toBeVisible()
      expect(composer).toBeVisible()
      expect(stage).toHaveStyle({ width: "75%" })
      expect(
        within(host).getByRole("button", { name: "Fullscreen" })
      ).toHaveAttribute("aria-pressed", "false")

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))

      expect(host).toHaveAttribute("data-layout", "fullscreen")
      expect(screen.getByTestId("room-app-host")).toBe(host)
      expect(roomShell).toHaveAttribute("data-room-app-focus", "true")
      expect(host).toHaveClass("room-app-host--fullscreen")
      expect(
        within(host).getByRole("button", { name: "Exit fullscreen" })
      ).toHaveAttribute("aria-pressed", "true")
      expect(roomHeader).not.toBeVisible()
      expect(roomHeader).toHaveAttribute("aria-hidden", "true")
      expect(roomHeader).toHaveAttribute("inert")
      expect(screen.getByTestId("stage-switcher")).not.toBeVisible()
      expect(screen.getByTestId("stage-switcher")).toHaveAttribute("inert")
      expect(chatPanel).not.toBeVisible()
      expect(chatPanel).toHaveAttribute("aria-hidden", "true")
      expect(chatPanel).toHaveAttribute("inert")
      expect(composer).not.toBeVisible()
      expect(composer.closest("[inert]")).toBe(chatPanel)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1).toBe(port)
      expect(channels).toHaveLength(1)
      expect(port.close).not.toHaveBeenCalled()

      fireEvent.click(
        within(host).getByRole("button", { name: "Exit fullscreen" })
      )

      expect(host).toHaveAttribute("data-layout", "stage")
      expect(screen.getByTestId("room-app-host")).toBe(host)
      expect(roomShell).not.toHaveAttribute("data-room-app-focus")
      expect(roomHeader).toBeVisible()
      expect(roomHeader).not.toHaveAttribute("inert")
      expect(chatPanel).toBeVisible()
      expect(chatPanel).not.toHaveAttribute("inert")
      expect(composer).toBeVisible()
      expect(stage).toHaveStyle({ width: "75%" })
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1).toBe(port)
      expect(channels).toHaveLength(1)
      expect(port.close).not.toHaveBeenCalled()
    })

    it("makes the fullscreen Stage own the whole Room content region", async () => {
      renderAppRoom()
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const host = slotHost("test-app-1")

      // Normal split layout: the Stage owns its share of the Room content row.
      const stage = screen.getByTestId("room-stage")
      expect(stage).toHaveStyle({ width: "75%" })

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))

      // Focus mode must be a Room layout state: the Stage drops the split width
      // and owns the full content region instead of a fixed descendant trying
      // to escape a clipped split pane (the iPad Safari clipping bug).
      expect(host).toHaveAttribute("data-layout", "fullscreen")
      expect(stage).toHaveStyle({ width: "100%" })
      expect(stage).not.toHaveStyle({ width: "75%" })
      // The resident host stays inside that Stage subtree — no portal, no
      // remount, no separate fullscreen copy of the App.
      expect(stage.contains(host)).toBe(true)
      expect(screen.getByTestId("room-app-host")).toBe(host)

      fireEvent.click(
        within(host).getByRole("button", { name: "Exit fullscreen" })
      )

      // The exact normal split is restored, not a recomputed default.
      expect(stage).toHaveStyle({ width: "75%" })
      expect(host).toHaveAttribute("data-layout", "stage")
      expect(screen.getByTestId("room-app-host")).toBe(host)
    })

    it("exits focus mode with Escape or Close while keeping the App resident", async () => {
      renderAppRoom()
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      const host = slotHost("test-app-1")

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))
      fireEvent.keyDown(window, { key: "Escape" })
      expect(host).toHaveAttribute("data-layout", "stage")

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))
      fireEvent.click(within(host).getByRole("button", { name: "Close" }))
      expect(host).toHaveAttribute("data-layout", "stage")
      expect(slotHidden("test-app-1")).toBe(true)
      expect(
        screen.getByTestId("interaction-chat").closest(".room-chat-panel")
      ).toBeVisible()
      expect(
        screen.getByPlaceholderText("Message the room or @ an Agent…")
      ).toBeVisible()
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels).toHaveLength(1)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(slotHidden("test-app-1")).toBe(false)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("does not expand an inactive resident App and clears focus when Stage changes", async () => {
      renderAppRoom()
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))

      const hiddenAppAHost = slotHost("test-app-1")
      const inactiveFullscreenButton = hiddenAppAHost.querySelector(
        'button[aria-label="Fullscreen"]'
      ) as HTMLButtonElement
      fireEvent.click(inactiveFullscreenButton)
      expect(hiddenAppAHost).toHaveAttribute("data-layout", "stage")

      const appBHost = slotHost("test-app-2")
      fireEvent.click(
        within(appBHost).getByRole("button", { name: "Fullscreen" })
      )
      expect(appBHost).toHaveAttribute("data-layout", "fullscreen")

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(appBHost).toHaveAttribute("data-layout", "stage")
      expect(slotHidden("test-app-2")).toBe(true)
      expect(slotHidden("test-app-1")).toBe(false)
    })

    it("keeps focus mode and the same iframe through a transient transport reconnect", async () => {
      const view = renderAppRoom()
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      const host = slotHost("test-app-1")
      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))
      const port = channels[0].port1

      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "reconnecting",
        roomAppsEnabled: false,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      expect(host).toHaveAttribute("data-layout", "fullscreen")
      expect(screen.getByTestId("room-app-host")).toBe(host)
      const slot = screen.getByTestId("room-app-slot-test-app-1")
      const reconnectGuard = screen.getByTestId("room-reconnect-guard")
      expect(reconnectGuard).toBeVisible()
      expect(reconnectGuard).toHaveAttribute("role", "alert")
      expect(reconnectGuard).not.toHaveAttribute("inert")
      expect(reconnectGuard).not.toHaveAttribute("aria-hidden", "true")
      expect(slot).toHaveAttribute("inert")
      expect(slot).toHaveAttribute("aria-hidden", "true")
      expect(screen.getByRole("main")).toHaveAttribute(
        "data-room-app-focus",
        "true"
      )
      expect(slotHidden("test-app-1")).toBe(false)
      expect(
        screen.getByTestId("interaction-chat").closest(".room-chat-panel")
      ).not.toBeVisible()
      expect(
        screen.getByPlaceholderText("Message the room or @ an Agent…")
      ).not.toBeVisible()
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1).toBe(port)
      expect(port.close).not.toHaveBeenCalled()

      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      expect(host).toHaveAttribute("data-layout", "fullscreen")
      expect(screen.getByTestId("room-app-host")).toBe(host)
      expect(
        screen.queryByTestId("room-reconnect-guard")
      ).not.toBeInTheDocument()
      expect(slot).not.toHaveAttribute("inert")
      expect(slot).not.toHaveAttribute("aria-hidden", "true")
      expect(screen.getByRole("main")).toHaveAttribute(
        "data-room-app-focus",
        "true"
      )
      expect(
        screen.getByTestId("interaction-chat").closest(".room-chat-panel")
      ).not.toBeVisible()
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1).toBe(port)
      expect(channels).toHaveLength(1)
      expect(port.close).not.toHaveBeenCalled()
    })

    it("leaves focus mode if the active App becomes unavailable", async () => {
      renderAppRoom()
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      const host = slotHost("test-app-1")
      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))

      act(() => {
        channels[0].port1.emit({
          type: "ready",
          appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
          handshakeToken: "wrong-handshake",
        })
      })

      await waitFor(() => expect(host).toHaveAttribute("data-layout", "stage"))
      expect(slotHidden("test-app-1")).toBe(true)
      expect(slotHost("test-app-1")).toHaveTextContent(
        "This Room App is unavailable"
      )
    })

    it("treats visual Close as Hide and restores the same session on reopen", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))
      const iframe = slotIframe("test-app-2")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)

      fireEvent.click(
        within(slotHost("test-app-2")).getByRole("button", { name: "Close" })
      )

      // The Stage returns to participants; the session stays resident.
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(slotHidden("test-app-2")).toBe(true)
      expect(slotIframe("test-app-2")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))
      expect(slotHidden("test-app-2")).toBe(false)
      expect(slotIframe("test-app-2")).toBe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("keeps one resident App while another is shown and restores the same iframe", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const appAIframe = slotIframe("test-app-1")
      loadAppIframe(appAIframe)
      const appAPort = channels[0].port1
      expect(channels).toHaveLength(1)

      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))

      expect(slotHidden("test-app-1")).toBe(true)
      expect(slotHidden("test-app-2")).toBe(false)
      // Both sessions exist; App A was hidden, not destroyed.
      expect(screen.getAllByTestId("room-app-iframe")).toHaveLength(2)
      expect(screen.getAllByTestId("room-app-host")).toHaveLength(2)
      expect(slotIframe("test-app-1")).toBe(appAIframe)
      expect(appAPort.close).not.toHaveBeenCalled()

      const appBIframe = slotIframe("test-app-2")
      loadAppIframe(appBIframe)
      expect(channels).toHaveLength(2)

      // Back to App A: the exact same iframe/port/App-local state.
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(slotHidden("test-app-1")).toBe(false)
      expect(slotIframe("test-app-1")).toBe(appAIframe)
      expect(appAPort.close).not.toHaveBeenCalled()
      expect(channels).toHaveLength(2)
      // App B stays resident behind it.
      expect(slotHidden("test-app-2")).toBe(true)
      expect(slotIframe("test-app-2")).toBe(appBIframe)
    })

    it("keeps both Humans' resident App A sessions when both hide and reopen", async () => {
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

      fireEvent.click(aliceView.getByTestId("stage-app-test-app-1"))
      fireEvent.click(bobView.getByTestId("stage-app-test-app-1"))
      const aliceIframe = aliceView.getByTestId(
        "room-app-iframe"
      ) as HTMLIFrameElement
      const bobIframe = bobView.getByTestId(
        "room-app-iframe"
      ) as HTMLIFrameElement
      loadAppIframe(aliceIframe)
      loadAppIframe(bobIframe)
      expect(channels).toHaveLength(2)

      // Both Humans hide App A for this browser session.
      fireEvent.click(aliceView.getByTestId("stage-app-test-app-1"))
      fireEvent.click(bobView.getByTestId("stage-app-test-app-1"))
      expect(
        aliceView.getByTestId("room-app-slot-test-app-1").className
      ).toContain("hidden")
      expect(
        bobView.getByTestId("room-app-slot-test-app-1").className
      ).toContain("hidden")
      // Neither resident session was destroyed, so an incumbent App A can
      // still answer the bounded canonical bootstrap when it is reopened.
      for (const channel of channels)
        expect(channel.port1.close).not.toHaveBeenCalled()

      // Reopening restores the same iframes and sessions on both browsers.
      fireEvent.click(aliceView.getByTestId("stage-app-test-app-1"))
      fireEvent.click(bobView.getByTestId("stage-app-test-app-1"))
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

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const frameWindow = loadAppIframe(slotIframe("test-app-1"))
      completeHandshake(frameWindow, "test-app-1", channels[0].port1)

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(slotHidden("test-app-1")).toBe(true)

      // A hidden resident App still receives the bounded logical messages it
      // needs to preserve and reconcile its own state.
      const payload = { type: "update", points: [[1, 2]] }
      act(() => {
        listener?.({
          protocolVersion: 1,
          appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
          lane: "reliable",
          sourceParticipantId: "other-human",
          payload,
        })
      })
      expect(channels[0].port1.postMessage).toHaveBeenCalledWith({
        type: "reliable",
        appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
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
      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)

      fireEvent.click(screen.getByTestId("stage-view-live-view"))
      expect(slotHidden("test-app-1")).toBe(true)
      expect(screen.getByTestId("task-live-view")).toBeInTheDocument()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(slotHidden("test-app-1")).toBe(false)

      fireEvent.click(screen.getByTestId("stage-view-screen"))
      expect(slotHidden("test-app-1")).toBe(true)
      expect(document.querySelector("video")).toBeInTheDocument()
      // The Task conversation scope is untouched by Stage switching, and the
      // App session survived both switches.
      expect(
        screen.getByTestId("interaction-tab-task-task-live")
      ).toHaveAttribute("aria-selected", "true")
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()
    })

    it("offers Screen while an App is open even without a Task Live View", async () => {
      renderAppRoom({
        resolvedRoomType: "screenshare",
        participants: [localParticipant, remoteScreenShare],
      })

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      expect(await screen.findByTestId("room-app-host")).toBeInTheDocument()
      expect(screen.queryByTestId("stage-view-live-view")).toBeNull()

      // Screen is a Stage surface in its own right: it must stay reachable
      // while an App is open, with no Live View sharing the switcher.
      fireEvent.click(screen.getByTestId("stage-view-screen"))
      expect(slotHidden("test-app-1")).toBe(true)
      expect(document.querySelector("video")).toBeInTheDocument()
    })

    it("offers Live View while an App is open even without a screen share", async () => {
      renderAppRoom({
        messages: [taskRequestMessage],
        taskLiveViews: { "task-live": taskLiveViewSnapshot },
      })

      fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))
      expect(await screen.findByTestId("room-app-host")).toBeInTheDocument()
      expect(screen.queryByTestId("stage-view-screen")).toBeNull()

      // Live View is likewise reachable on its own availability.
      fireEvent.click(screen.getByTestId("stage-view-live-view"))
      expect(slotHidden("test-app-2")).toBe(true)
      expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
    })

    it("keeps hidden App slots non-interactive", async () => {
      renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))

      // display:none removes the hidden host from hit-testing and tab order;
      // inert + aria-hidden state the intent explicitly.
      const hidden = slot("test-app-1")
      expect(hidden.className).toContain("hidden")
      expect(hidden).toHaveAttribute("aria-hidden", "true")
      expect(hidden).toHaveAttribute("inert")

      const visible = slot("test-app-2")
      expect(visible.className).not.toContain("hidden")
      expect(visible).toHaveAttribute("aria-hidden", "false")
      expect(visible).not.toHaveAttribute("inert")
    })

    it("keeps resident hosts across an ordinary transport reconnect", async () => {
      const view = renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)

      // Ordinary SFU/media reconnect: useSfuChatRoom drops the exposed flag
      // while it rebuilds the App DataChannels. That is not a catalog removal.
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "reconnecting",
        roomAppsEnabled: false,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )

      // The App is hidden while the transport is unavailable, but its host and
      // MessagePort stay resident.
      expect(slotHidden("test-app-1")).toBe(true)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels).toHaveLength(1)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      // Reconnect succeeds: same host, same Stage selection.
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )

      expect(slotHidden("test-app-1")).toBe(false)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels).toHaveLength(1)
      expect(channels[0].port1.close).not.toHaveBeenCalled()
    })

    it("tears resident hosts down on a stable disable, closing each port once", async () => {
      const view = renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))
      loadAppIframe(slotIframe("test-app-1"))
      loadAppIframe(slotIframe("test-app-2"))
      expect(channels).toHaveLength(2)

      // ROOM_APPS_ENABLED off while the Room stays connected: a real disable,
      // not a reconnect.
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
        expect(screen.queryByTestId("room-app-slot-test-app-1")).toBeNull()
      )
      expect(screen.queryByTestId("room-app-slot-test-app-2")).toBeNull()
      expect(channels[0].port1.close).toHaveBeenCalledTimes(1)
      expect(channels[1].port1.close).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
    })

    it("closes every resident MessagePort exactly once when the Room unmounts", async () => {
      const view = renderAppRoom()

      fireEvent.click(screen.getByTestId("stage-app-test-app-1"))
      fireEvent.click(screen.getByTestId("stage-app-test-app-2"))
      loadAppIframe(slotIframe("test-app-1"))
      loadAppIframe(slotIframe("test-app-2"))
      expect(channels).toHaveLength(2)

      view.unmount()

      expect(channels[0].port1.close).toHaveBeenCalledTimes(1)
      expect(channels[1].port1.close).toHaveBeenCalledTimes(1)
    })

    it("direct-launches a Lab App once and measures only ready Human sharing", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const analyticsSpy = vi.mocked(trackAnalyticsEvent)
      analyticsSpy.mockClear()
      const remoteAgent = {
        peerId: "agent-peer",
        name: "Pi",
        kind: "agent",
        room: "test-room",
      }
      const remoteHuman = {
        peerId: "human-b",
        name: "Bob",
        kind: "human",
        room: "test-room",
        muteState: false,
      }
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant, remoteAgent],
      })
      const view = render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )

      const appOneButton = await screen.findByTestId("stage-app-test-app-1")
      await waitFor(() =>
        expect(appOneButton).toHaveAttribute("aria-pressed", "true")
      )
      const iframe = within(
        screen.getByTestId("room-app-slot-test-app-1")
      ).getByTestId("room-app-iframe") as HTMLIFrameElement
      const frameWindow = loadAppIframe(iframe)
      expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
        "RoomAppMounted",
        expect.anything()
      )

      completeHandshake(frameWindow, "test-app-1", channels[0].port1)
      expect(trackAnalyticsEvent).toHaveBeenCalledWith("RoomAppMounted", {
        app: "test-app-1",
      })
      act(() => {
        channels[0].port1.emit({
          type: "milestone",
          appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
          milestone: "engaged",
        })
        channels[0].port1.emit({
          type: "milestone",
          appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
          milestone: "engaged",
        })
      })
      expect(trackAnalyticsEvent).toHaveBeenCalledTimes(2)
      expect(trackAnalyticsEvent).toHaveBeenLastCalledWith("RoomAppEngaged", {
        app: "test-app-1",
        participantsBucket: "1",
      })
      expect(baseHookReturn.sendRoomAppMessage).not.toHaveBeenCalled()
      expect(baseHookReturn.sendRoomAppUnicast).not.toHaveBeenCalled()
      expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
        "RoomAppSharedSession",
        expect.anything()
      )

      // The Agent does not satisfy the Human shared-use milestone. A late
      // second Human does, after the App is already ready.
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant, remoteAgent, remoteHuman],
      })
      view.rerender(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )
      expect(trackAnalyticsEvent).toHaveBeenCalledWith("RoomAppSharedSession", {
        app: "test-app-1",
        participantsBucket: "2-3",
      })

      // Manual Stage hide/show and an ordinary transport reconnect keep the
      // same resident iframe/MessagePort; initial launch is not repeated.
      fireEvent.click(appOneButton)
      expect(
        screen.getByTestId("room-app-slot-test-app-1").className
      ).toContain("hidden")
      fireEvent.click(appOneButton)
      expect(screen.getByTestId("room-app-iframe")).toBe(iframe)

      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "reconnecting",
        roomAppsEnabled: false,
        participants: [localParticipant, remoteAgent, remoteHuman],
      })
      view.rerender(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant, remoteAgent, remoteHuman],
      })
      view.rerender(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-1"
        />
      )
      expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
      expect(channels).toHaveLength(1)
      expect(
        analyticsSpy.mock.calls.filter(([event]) => event === "RoomAppMounted")
      ).toHaveLength(1)
      expect(
        analyticsSpy.mock.calls.filter(
          ([event]) => event === "RoomAppSharedSession"
        )
      ).toHaveLength(1)
    })

    it("reports the same coarse telemetry for a later curated App", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const analyticsSpy = vi.mocked(trackAnalyticsEvent)
      analyticsSpy.mockClear()
      const remoteHuman = {
        peerId: "human-b",
        name: "Bob",
        kind: "human",
        room: "test-room",
        muteState: false,
      }
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant, remoteHuman],
      })
      render(
        <RoomContent
          roomName="test-room"
          nickName="Alice"
          roomType="audio"
          initialRoomAppId="test-app-10"
        />
      )

      const iframe = (await screen.findByTestId(
        "room-app-iframe"
      )) as HTMLIFrameElement
      expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
        "RoomAppMounted",
        expect.anything()
      )

      completeHandshake(loadAppIframe(iframe), "test-app-10", channels[0].port1)

      expect(trackAnalyticsEvent).toHaveBeenCalledWith("RoomAppMounted", {
        app: "test-app-10",
      })
      await waitFor(() =>
        expect(trackAnalyticsEvent).toHaveBeenCalledWith(
          "RoomAppSharedSession",
          { app: "test-app-10", participantsBucket: "2-3" }
        )
      )
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
