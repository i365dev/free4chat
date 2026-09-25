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
import {
  ROOM_APP_INLINE_SHORTCUTS_DESKTOP,
  ROOM_APP_INLINE_SHORTCUTS_MOBILE,
} from "../common/roomAppRecents"
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
  localMicState: "not_enabled" as const,
  toggleMicrophone: vi.fn(),
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
    analyticsRoomId: crypto.randomUUID(),
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
    // #98 recency is remembered per browser tab, so one test's opened Apps must
    // never leak into the next test's inline Stage strip.
    window.sessionStorage.clear()
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("shows Harness-advertised select controls only after choosing an explicit project", async () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      participants: [
        {
          peerId: "human-local",
          name: "tester",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
          muteState: false,
          taskSessionContinuation: true,
        },
      ],
      requestTaskSessions: vi.fn(async () => ({
        ok: true,
        page: {
          sessions: [],
          projects: [{ token: "project-token-1", label: "free4chat" }],
          hasMore: false,
          controls: {
            currentModeId: "read-only",
            modes: [
              { id: "read-only", name: "Ask for approval" },
              { id: "agent-full-access", name: "Full access" },
            ],
            configOptions: [
              {
                id: "model",
                name: "Model",
                type: "select",
                currentValue: "gpt-6-luna",
                options: [
                  { value: "gpt-6-luna", name: "6 Luna" },
                  { value: "gpt-5.6-sol", name: "5.6 Sol" },
                ],
              },
            ],
          },
        },
      })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getAllByLabelText("Start task with Codex")[0])
    fireEvent.click(screen.getByTestId("task-project-discover"))

    await screen.findByTestId("task-session-project-toggle")
    expect(
      screen.queryByLabelText("Harness-native Model")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText("Harness-native mode")
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("task-session-project-toggle"))
    fireEvent.click(screen.getByTestId("task-session-project-option"))

    const model = await screen.findByLabelText("Harness-native Model")
    expect(within(model).getByRole("option", { name: "6 Luna" })).toHaveValue(
      "gpt-6-luna"
    )
    expect(within(model).getByRole("option", { name: "5.6 Sol" })).toHaveValue(
      "gpt-5.6-sol"
    )
    fireEvent.change(model, { target: { value: "gpt-5.6-sol" } })
    expect(model).toHaveValue("gpt-5.6-sol")
    expect(screen.getByLabelText("Harness-native mode")).toHaveValue("")
    expect(
      within(screen.getByLabelText("Harness-native mode")).getByRole("option", {
        name: "Full access",
      })
    ).toHaveValue("agent-full-access")
  })

  it("lets a project first discovered on page two be selected for a new Task", async () => {
    const requestTaskSessions = vi.fn(
      async (_peerId: string, options?: { pageToken?: string }) => ({
        ok: true as const,
        page: options?.pageToken
          ? {
              sessions: [],
              projects: [
                { token: "page-two-project", label: "second-project" },
              ],
              hasMore: false,
            }
          : {
              sessions: [],
              projects: [{ token: "page-one-project", label: "first-project" }],
              hasMore: true,
              nextPageToken: "page-two",
            },
      })
    )
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      participants: [
        {
          peerId: "human-local",
          name: "tester",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
          muteState: false,
          taskSessionContinuation: true,
        },
      ],
      requestTaskSessions,
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getAllByLabelText("Start task with Codex")[0])
    fireEvent.click(screen.getByTestId("task-project-discover"))
    await screen.findByTestId("task-session-project-toggle")
    fireEvent.click(screen.getByTestId("task-session-project-toggle"))
    expect(screen.getAllByTestId("task-session-project-option")).toHaveLength(1)
    expect(screen.queryByText("second-project")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("task-session-project-toggle"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-session-load-more"))
    })
    await waitFor(() => expect(requestTaskSessions).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByTestId("task-session-project-toggle"))
    const options = screen.getAllByTestId("task-session-project-option")
    expect(options).toHaveLength(2)
    fireEvent.click(options[1])
    expect(
      screen.getByTestId("task-session-project-summary")
    ).toHaveTextContent("second-project")
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

  it("reconciles selected Harness controls when refreshed advertisements change", async () => {
    const controls = {
      currentModeId: "read-only",
      modes: [
        { id: "read-only", name: "Read only" },
        { id: "agent", name: "Approve for me" },
      ],
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: "gpt-6-luna",
          options: [
            { value: "gpt-6-luna", name: "6 Luna" },
            { value: "gpt-5.6-sol", name: "5.6 Sol" },
          ],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select" as const,
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
          ],
        },
      ],
    }
    const changedControls = {
      ...controls,
      modes: [{ id: "read-only", name: "Read only" }],
      configOptions: [
        {
          ...controls.configOptions[0],
          options: [{ value: "gpt-6-luna", name: "6 Luna" }],
        },
        controls.configOptions[1],
      ],
    }
    let requestCount = 0
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      participants: [
        {
          peerId: "human-local",
          name: "tester",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
          muteState: false,
          taskSessionContinuation: true,
        },
      ],
      requestTaskSessions: vi.fn(async () => {
        requestCount += 1
        return {
          ok: true as const,
          page: {
            sessions: [],
            projects: [{ token: "project-token-1", label: "free4chat" }],
            hasMore: false,
            controls: requestCount >= 3 ? changedControls : controls,
          },
        }
      }),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getAllByLabelText("Start task with Codex")[0])
    fireEvent.click(screen.getByTestId("task-project-discover"))
    await screen.findByTestId("task-session-project-toggle")
    fireEvent.click(screen.getByTestId("task-session-project-toggle"))
    fireEvent.click(screen.getByTestId("task-session-project-option"))

    const mode = await screen.findByLabelText("Harness-native mode")
    const model = await screen.findByLabelText("Harness-native Model")
    const effort = await screen.findByLabelText(
      "Harness-native Reasoning effort"
    )
    fireEvent.change(mode, { target: { value: "agent" } })
    fireEvent.change(model, { target: { value: "gpt-5.6-sol" } })
    fireEvent.change(effort, { target: { value: "medium" } })
    expect(mode).toHaveValue("agent")
    expect(model).toHaveValue("gpt-5.6-sol")
    expect(effort).toHaveValue("medium")

    fireEvent.click(screen.getByTestId("task-session-refresh"))
    await waitFor(() => {
      expect(screen.getByLabelText("Harness-native mode")).toHaveValue("")
      expect(screen.getByLabelText("Harness-native Model")).toHaveValue("")
      expect(
        screen.getByLabelText("Harness-native Reasoning effort")
      ).toHaveValue("medium")
    })
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
          turnSequence: 42,
        },
        {
          agentParticipantId: "agent-pi",
          scopeId: "task:task-t",
          state: "thinking",
          turnSequence: 43,
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

  it("offers Interrupt from the authoritative execution projection, not AgentActivity", () => {
    const sendTaskInterrupt = vi.fn(() => true)
    // Local spies: an interrupt must never synthesize chat or action content.
    const sendTextMessage = vi.fn()
    const sendActionMessage = vi.fn()
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-interrupt",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-codex",
        summary: "Long-running task",
      },
    }
    const agentParticipant = {
      peerId: "agent-codex",
      name: "Codex",
      kind: "agent",
      room: "test-room",
      muteState: false,
    }
    const secondaryParticipant = {
      peerId: "agent-pi",
      name: "Pi",
      kind: "agent",
      room: "test-room",
      muteState: false,
    }

    // Task retained and selected, but no authoritative execution turn and no
    // activity: the Task is not running, so no Interrupt control may be
    // offered.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [agentParticipant],
      agentActivities: [],
      taskExecutions: [],
      sendTaskInterrupt,
      sendTextMessage,
      sendActionMessage,
    })
    const idle = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-interrupt"))
    expect(screen.queryByTestId("task-interrupt")).not.toBeInTheDocument()
    idle.unmount()

    // A legacy Agent Runtime (pre-#414 binary) reports canonical activity with
    // no exact turn and publishes no execution projection: the Human still sees
    // it working, but there is no interrupt authority to bind a click to.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [agentParticipant],
      agentActivities: [
        {
          agentParticipantId: "agent-codex",
          scopeId: "task:task-interrupt",
          state: "thinking",
        },
      ],
      taskExecutions: [],
      sendTaskInterrupt,
      sendTextMessage,
      sendActionMessage,
    })
    const legacyActivity = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-interrupt"))
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "Codex · Thinking…"
    )
    expect(screen.queryByTestId("task-interrupt")).not.toBeInTheDocument()
    legacyActivity.unmount()

    // Only a SECONDARY participating Agent is active: the canonical Agent owns
    // no running turn, so no Interrupt may be offered.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [agentParticipant, secondaryParticipant],
      agentActivities: [
        {
          agentParticipantId: "agent-pi",
          scopeId: "task:task-interrupt",
          state: "using_tools",
          turnSequence: 7,
        },
      ],
      taskExecutions: [],
      sendTaskInterrupt,
      sendTextMessage,
      sendActionMessage,
    })
    const secondaryOnly = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-interrupt"))
    expect(screen.queryByTestId("task-interrupt")).not.toBeInTheDocument()
    secondaryOnly.unmount()

    // #421 Fix C — the production dogfood case. The authoritative execution
    // projection names turn 42 and the Agent is still working, but the
    // presentation-only AgentActivity was lost (a hibernated Room reconciled
    // execution truth only). Interrupt MUST still be offered, and it must bind
    // to the authoritative turn.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [agentParticipant, secondaryParticipant],
      agentActivities: [],
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-interrupt",
          currentTurnSequence: 42,
          phase: "running",
          queuedCount: 0,
        },
      ],
      sendTaskInterrupt,
      sendTextMessage,
      sendActionMessage,
    })
    const noActivity = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-interrupt"))
    fireEvent.click(screen.getByTestId("task-interrupt"))
    expect(sendTaskInterrupt).toHaveBeenCalledTimes(1)
    expect(sendTaskInterrupt).toHaveBeenCalledWith("task-interrupt", 42)
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(sendActionMessage).not.toHaveBeenCalled()
    noActivity.unmount()

    // Same Task with a STALE canonical activity (turn 99) plus the
    // authoritative turn 42: exactly one click, bound to 42 — never to the
    // presentation-only value.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants: [agentParticipant, secondaryParticipant],
      agentActivities: [
        {
          agentParticipantId: "agent-codex",
          scopeId: "task:task-interrupt",
          state: "using_tools",
          turnSequence: 99,
        },
        {
          agentParticipantId: "agent-pi",
          scopeId: "task:task-interrupt",
          state: "thinking",
          turnSequence: 7,
        },
      ],
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-interrupt",
          currentTurnSequence: 42,
          phase: "running",
          queuedCount: 0,
        },
      ],
      sendTaskInterrupt,
      sendTextMessage,
      sendActionMessage,
    })
    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-interrupt"))
    fireEvent.click(screen.getByTestId("task-interrupt"))

    expect(sendTaskInterrupt).toHaveBeenCalledTimes(2)
    expect(sendTaskInterrupt).toHaveBeenLastCalledWith("task-interrupt", 42)
    expect(sendTextMessage).not.toHaveBeenCalled()
    expect(sendActionMessage).not.toHaveBeenCalled()
  })

  it("renders an explicitly handed-off Agent's authoritative execution projection", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-handoff",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-hermes",
        summary: "Continue after executor loss",
      },
    }
    const handoff: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "text",
      sequence: 2,
      text: "@OpenCode continue this Task",
      taskRequestId: "task-handoff",
      targets: ["agent-opencode", "agent-pi"],
    }
    const sendTaskInterrupt = vi.fn()

    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest, handoff],
      participants: [
        {
          peerId: "human-local",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        // Hermes remains connected with a retained terminal projection.
        {
          peerId: "agent-hermes",
          name: "Hermes",
          kind: "agent",
          room: "test-room",
        },
        {
          peerId: "agent-opencode",
          name: "OpenCode",
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
      taskExecutions: [
        {
          agentParticipantId: "agent-hermes",
          taskRequestId: "task-handoff",
          queuedCount: 0,
          lastOutcome: "interrupted",
        },
        {
          agentParticipantId: "agent-opencode",
          taskRequestId: "task-handoff",
          currentTurnSequence: 88,
          phase: "running",
          queuedCount: 0,
        },
        {
          agentParticipantId: "agent-pi",
          taskRequestId: "task-handoff",
          queuedCount: 0,
        },
      ],
      sendTaskInterrupt,
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-handoff"))
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "OpenCode · Running"
    )
    fireEvent.click(screen.getByTestId("task-interrupt"))
    expect(sendTaskInterrupt).toHaveBeenCalledWith("task-handoff", 88)
  })

  it("preserves parallel execution truth and hides singular controls when two Agents are running", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-parallel",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-a",
        summary: "Parallel Task",
      },
    }
    const admission: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "text",
      sequence: 2,
      text: "@A and @B work on this Task",
      taskRequestId: "task-parallel",
      targets: ["agent-a", "agent-b"],
    }
    const sendTaskInterrupt = vi.fn()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest, admission],
      participants: [
        {
          peerId: "human-local",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-a",
          name: "A",
          kind: "agent",
          room: "test-room",
        },
        {
          peerId: "agent-b",
          name: "B",
          kind: "agent",
          room: "test-room",
        },
      ],
      taskExecutions: [
        {
          agentParticipantId: "agent-a",
          taskRequestId: "task-parallel",
          currentTurnSequence: 10,
          phase: "running",
          queuedCount: 0,
        },
        {
          agentParticipantId: "agent-b",
          taskRequestId: "task-parallel",
          currentTurnSequence: 20,
          phase: "running",
          queuedCount: 0,
        },
      ],
      sendTaskInterrupt,
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-parallel"))

    expect(screen.getByTestId("task-execution-ambiguous")).toHaveTextContent(
      "Multiple Agents are running this Task"
    )
    expect(screen.queryByTestId("task-interrupt")).toBeNull()
    expect(screen.queryByTestId("task-interrupt-and-send")).toBeNull()
    expect(sendTaskInterrupt).not.toHaveBeenCalled()
  })

  it("renders the Runtime execution projection and its structured controls", () => {
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-exec",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-codex",
        summary: "Long-running task",
      },
    }
    const participants = [
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
    ]
    const activity = {
      agentParticipantId: "agent-codex",
      scopeId: "task:task-exec",
      state: "thinking" as const,
      turnSequence: 42,
    }
    const base = {
      ...baseHookReturn,
      connectionStatus: "connected",
      messages: [taskRequest],
      participants,
      agentActivities: [activity],
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    }

    // Running + activity, and Running with a queue depth.
    mockUseSfuChatRoom.mockReturnValue({
      ...base,
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec",
          currentTurnSequence: 42,
          phase: "running",
          queuedCount: 0,
        },
      ],
    })
    const running = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-exec"))
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "Codex · Thinking…"
    )
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "Running"
    )
    expect(screen.queryByTestId("task-execution-status")).toBeNull()
    running.unmount()

    mockUseSfuChatRoom.mockReturnValue({
      ...base,
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec",
          currentTurnSequence: 42,
          phase: "running",
          queuedCount: 2,
        },
      ],
    })
    const queuedBehind = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-exec"))
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "Running · 2 queued"
    )
    queuedBehind.unmount()

    // Queued but not current: no interrupt control is offered.
    mockUseSfuChatRoom.mockReturnValue({
      ...base,
      agentActivities: [],
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec",
          queuedCount: 1,
        },
      ],
    })
    const queuedOnly = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-exec"))
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "Queued · 1 queued"
    )
    expect(screen.queryByTestId("task-interrupt")).not.toBeInTheDocument()
    queuedOnly.unmount()

    // Interrupting: the interrupt control is disabled.
    mockUseSfuChatRoom.mockReturnValue({
      ...base,
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec",
          currentTurnSequence: 42,
          phase: "interrupting",
          queuedCount: 0,
        },
      ],
    })
    const interrupting = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-exec"))
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "Interrupting"
    )
    // Both interrupt controls are disabled for the exact turn already being
    // interrupted, and the status label itself is presentation only.
    expect(screen.getByTestId("task-interrupt")).toBeDisabled()
    expect(
      screen.queryByTestId("task-interrupt-and-send")
    ).not.toBeInTheDocument()
    interrupting.unmount()

    // Interrupted and Session lost are rendered as published, never derived.
    for (const [execution, expected] of [
      [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec",
          queuedCount: 0,
          lastOutcome: "interrupted" as const,
        },
        "Interrupted",
      ],
      [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec",
          queuedCount: 0,
          availability: "session_lost" as const,
        },
        "Session lost",
      ],
    ] as const) {
      mockUseSfuChatRoom.mockReturnValue({
        ...base,
        agentActivities: [],
        taskExecutions: [execution],
      })
      const view = render(
        <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
      )
      fireEvent.click(screen.getByTestId("interaction-tab-task-task-exec"))
      expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
        expected
      )
      view.unmount()
    }
  })

  it("keeps a Task delivery error in the affected Task when switching views", () => {
    const taskA: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-unavailable",
        kind: "request",
        fromParticipantId: "human-local",
        targetParticipantId: "agent-a",
        summary: "Unavailable Agent",
      },
    }
    const taskB: Message = {
      ...taskA,
      sequence: 2,
      collab: {
        ...taskA.collab!,
        requestId: "task-healthy",
        targetParticipantId: "agent-b",
        summary: "Healthy Agent",
      },
    }

    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      localParticipantId: "human-local",
      messages: [taskA, taskB],
      participants: [
        {
          peerId: "human-local",
          name: "Hannah",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-a",
          name: "Unavailable",
          kind: "agent",
          room: "test-room",
        },
        {
          peerId: "agent-b",
          name: "Healthy",
          kind: "agent",
          room: "test-room",
        },
      ],
      taskLocalError: {
        taskRequestId: "task-unavailable",
        message:
          "That Agent is no longer in this Room. Choose a connected Agent.",
      },
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-unavailable"))
    expect(screen.getByTestId("task-local-error")).toHaveTextContent(
      "That Agent is no longer in this Room. Choose a connected Agent."
    )
    expect(screen.getByTestId("task-agent-activity")).toHaveTextContent(
      "That Agent is no longer in this Room"
    )

    fireEvent.click(screen.getByTestId("interaction-tab-task-task-healthy"))
    expect(screen.queryByTestId("task-local-error")).toBeNull()
  })

  it("sends one structured interrupt & send for a text draft only", () => {
    const sendTaskInterruptAndSend = vi.fn(() => true)
    const taskRequest: Message = {
      peerId: "human-local",
      name: "Hannah",
      kind: "human",
      type: "action",
      actionType: "collab",
      sequence: 1,
      collab: {
        requestId: "task-exec-send",
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
          muteState: false,
        },
      ],
      agentActivities: [
        {
          agentParticipantId: "agent-codex",
          scopeId: "task:task-exec-send",
          state: "using_tools",
          turnSequence: 42,
        },
      ],
      taskExecutions: [
        {
          agentParticipantId: "agent-codex",
          taskRequestId: "task-exec-send",
          currentTurnSequence: 42,
          phase: "running",
          queuedCount: 0,
        },
      ],
      sendTaskInterruptAndSend,
      localParticipantId: "human-local",
      getLocalRoomAuth: vi.fn(() => ({ participantId: "human-local" })),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-exec-send"))

    // No draft text: only the existing interrupt control is offered.
    expect(
      screen.queryByTestId("task-interrupt-and-send")
    ).not.toBeInTheDocument()

    const textarea = screen.getByLabelText("Message the room or @ an Agent")
    fireEvent.change(textarea, { target: { value: "Try the other approach" } })
    fireEvent.click(screen.getByTestId("task-interrupt-and-send"))

    expect(sendTaskInterruptAndSend).toHaveBeenCalledTimes(1)
    expect(sendTaskInterruptAndSend).toHaveBeenCalledWith(
      "task-exec-send",
      42,
      "Try the other approach"
    )
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
          turnSequence: 42,
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

  it("keeps an orphaned Task's composer reachable only for an explicit replacement", () => {
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
          peerId: "agent-opencode",
          name: "OpenCode",
          kind: "agent",
          room: "test-room",
        },
      ],
    })
    rerender(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    expect(screen.getByLabelText("Task unavailable")).toBeInTheDocument()
    expect(screen.getByTestId("task-replacement-needed")).toHaveTextContent(
      "@ a connected Agent to continue this Task"
    )
    expect(
      screen.getByLabelText("Message the room or @ an Agent")
    ).toBeEnabled()

    const composer = screen.getByLabelText("Message the room or @ an Agent")
    fireEvent.change(composer, { target: { value: "@Open" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    fireEvent.change(composer, {
      target: { value: "@OpenCode continue this Task" },
    })
    fireEvent.click(screen.getByLabelText("Send message"))
    expect(sendTextMessage).toHaveBeenCalledWith(
      "@OpenCode continue this Task",
      ["agent-opencode"],
      "task-orphan"
    )
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

    /**
     * #98: the Stage strip is progressive disclosure, so an App that is neither
     * current nor recent lives behind the `Apps…` launcher. Opening an App is
     * the same one-action flow either way, so these tests select by App, not by
     * chip: an inline chip is used when present, otherwise the launcher opens
     * and the App is picked there.
     */
    function openAppInLauncher(
      container: ReturnType<typeof within>,
      appId: string
    ) {
      const inline = container.queryAllByTestId(`stage-app-${appId}`)
      if (inline.length > 0) {
        fireEvent.click(inline[0])
        return
      }
      fireEvent.click(container.getByTestId("stage-apps-launcher"))
      fireEvent.click(container.getByTestId(`launcher-app-${appId}`))
    }

    /** Opens the `Apps…` launcher surface (idempotent within one assertion). */
    function openAppsLauncher(container: ReturnType<typeof within>) {
      if (container.queryAllByTestId("room-app-launcher").length > 0) return
      fireEvent.click(container.getByTestId("stage-apps-launcher"))
    }

    /**
     * Waits for the catalog-driven Stage strip, then opens the launcher. Tests
     * with fake timers must use `openAppsLauncher` instead: `findBy*` is
     * timer-driven and would never settle there.
     */
    async function openAppsLauncherWhenReady(
      container: ReturnType<typeof within>
    ) {
      if (container.queryAllByTestId("room-app-launcher").length === 0)
        await container.findByTestId("stage-apps-launcher")
      openAppsLauncher(container)
    }

    /** Launches a curated App and completes its iframe handshake. */
    function launchAndHandshake(appId: string) {
      openAppInLauncher(screen, appId)
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
      // The strip stays bounded: the deep-linked App is inline, and the rest of
      // the catalog is one launcher action away.
      expect(screen.getByTestId("stage-app-test-app-3")).toBeInTheDocument()
      await openAppsLauncherWhenReady(screen)
      expect(screen.getByTestId("launcher-app-test-app-1")).toBeInTheDocument()
      expect(screen.getByTestId("launcher-app-test-app-2")).toBeInTheDocument()
      fireEvent.click(screen.getByTestId("room-app-launcher-close"))
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
        // The whole supplied catalog remains discoverable through the launcher.
        await openAppsLauncherWhenReady(screen)
        for (const stageId of TEST_ROOM_APP_CATALOG.map((app) => app.id))
          expect(
            screen.getByTestId(`launcher-app-${stageId}`)
          ).toBeInTheDocument()
        fireEvent.click(screen.getByTestId("room-app-launcher-close"))

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

    it("keeps the full supplied catalog reachable while bounding the inline strip", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()

      const stageIds = TEST_ROOM_APP_CATALOG.map((app) => app.id)
      // The launcher must expose the whole supplied catalog, and that catalog
      // must stay larger than both bounds for those bounds to mean anything.
      expect(stageIds.length).toBeGreaterThan(ROOM_APP_MAX_INSTANCES)
      expect(stageIds.length).toBeGreaterThan(ROOM_APP_INLINE_SHORTCUTS_DESKTOP)

      // Nothing has been opened yet: no App is inline, but every promoted App is
      // already one action away and keeps its Lab-provided label verbatim.
      for (const id of stageIds)
        expect(screen.queryByTestId(`stage-app-${id}`)).toBeNull()
      await openAppsLauncherWhenReady(screen)
      for (const app of TEST_ROOM_APP_CATALOG) {
        const button = await screen.findByTestId(`launcher-app-${app.id}`)
        expect(button).toBeInTheDocument()
        // The user-visible label comes from the Lab definition, without a badge.
        expect(button.textContent).toContain(app.label)
      }
      fireEvent.click(screen.getByTestId("room-app-launcher-close"))
      expect(screen.queryByTestId("room-app-launcher")).toBeNull()

      openAppInLauncher(screen, "test-app-1")
      openAppInLauncher(screen, "test-app-4")
      openAppInLauncher(screen, "test-app-6")

      // The residency bound still means something.
      expect(screen.getAllByTestId("room-app-iframe")).toHaveLength(
        ROOM_APP_MAX_INSTANCES
      )
      expect(screen.queryByTestId("room-app-slot-test-app-1")).toBeNull()
      expect(screen.getByTestId("room-app-slot-test-app-4")).toBeInTheDocument()
      expect(screen.getByTestId("room-app-slot-test-app-6")).toBeInTheDocument()

      // The strip renders the current App plus a bounded recent set — never the
      // whole catalog — while the launcher still exposes every App. jsdom's
      // 1024px viewport is above Core's md breakpoint, so the wide bound applies.
      const inlineChips = stageIds.flatMap((id) => {
        const chip = screen.queryByTestId(`stage-app-${id}`)
        return chip ? [chip] : []
      })
      expect(inlineChips).toHaveLength(ROOM_APP_INLINE_SHORTCUTS_DESKTOP)
      // Reading order is recency order: the current App first, then the Apps
      // opened before it in this Room.
      const inlineIds = inlineChips
        .slice()
        .sort((left, right) =>
          left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1
        )
        .map((chip) =>
          chip.getAttribute("data-testid")!.replace("stage-app-", "")
        )
      expect(inlineIds).toEqual(["test-app-6", "test-app-4", "test-app-1"])
      await openAppsLauncherWhenReady(screen)
      for (const id of stageIds)
        expect(screen.getByTestId(`launcher-app-${id}`)).toBeInTheDocument()
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
        // Fake timers are active, so the catalog is already flushed by the
        // `act` above and the strip must be present without `findBy*` waiting.
        openAppsLauncher(screen)
        expect(
          screen.getByTestId("launcher-app-test-app-1")
        ).toBeInTheDocument()
        fireEvent.click(screen.getByTestId("room-app-launcher-close"))
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
        // The new metadata reaches the UI. The chip's own label is asserted
        // separately from its current-App marker so a truncating layout and the
        // recency affordance cannot silently rewrite the Lab-provided label.
        expect(
          within(screen.getByTestId("stage-app-test-app-1")).getByTestId(
            "stage-app-label-test-app-1"
          ).textContent
        ).toBe("Test App 1 renamed")
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

      // The launcher is the catalog surface, so the Lab-provided label must
      // reach it verbatim for Apps that were never opened in this Room.
      await openAppsLauncherWhenReady(screen)
      for (const { id, label } of TEST_ROOM_APP_CATALOG.slice(7))
        expect(screen.getByTestId(`launcher-app-${id}`).textContent).toBe(label)
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
      expect(screen.getByTestId("room-stage")).toHaveAttribute(
        "data-stage-surface",
        "people"
      )
      expect(document.querySelector(".room-cosmos-sky")).not.toBeNull()
      expect(screen.getByTestId("interaction-tab-room")).toHaveAttribute(
        "aria-selected",
        "true"
      )

      openAppInLauncher(screen, "test-app-1")

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
      expect(stage).toHaveAttribute("data-stage-surface", "content")
      expect(document.querySelector(".room-cosmos-sky")).toBeNull()

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

      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)
      expect(channels).toHaveLength(1)

      // Hide by toggling the Stage entry off.
      openAppInLauncher(screen, "test-app-1")
      expect(slotHidden("test-app-1")).toBe(true)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels[0].port1.close).not.toHaveBeenCalled()

      // Show it again: same host, same session, no new MessagePort.
      openAppInLauncher(screen, "test-app-1")
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
      openAppInLauncher(screen, "test-app-1")
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
      openAppInLauncher(screen, "test-app-1")
      expect(audioSink("peer-bob")).toBe(sink)

      // ...is hidden again...
      openAppInLauncher(screen, "test-app-1")
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(audioSink("peer-bob")).toBe(sink)

      // ...and reopened.
      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
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
      openAppInLauncher(screen, "test-app-1")
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

    it("owns the microphone control in Room chrome instead of a Stage card", () => {
      const toggleMicrophone = vi.fn()
      const { rerender } = renderAppRoom({
        participants: [localParticipant],
        localMicState: "not_enabled" as const,
        toggleMicrophone,
      })

      // The canonical control is Room chrome: reachable with the ordinary
      // participant Stage, and truthful before voice is ever enabled.
      const control = screen.getByTestId("room-mic-control")
      expect(control).toBeVisible()
      expect(control).toHaveTextContent("Enable mic")
      expect(control).toHaveAttribute("aria-label", "Enable microphone")
      fireEvent.click(control)
      expect(toggleMicrophone).toHaveBeenCalledTimes(1)
      // The Stage card is only a projection/convenience surface.
      expect(
        screen.queryByTestId("room-mic-control-fullscreen")
      ).not.toBeInTheDocument()

      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
        localMicState: "live",
        toggleMicrophone,
      })
      rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      expect(screen.getByTestId("room-mic-control")).toHaveTextContent("Mic on")
      expect(screen.getByTestId("room-mic-control")).toHaveAttribute(
        "aria-label",
        "Mute microphone"
      )
    })

    it("keeps the Room mic control reachable while a Room App owns the Stage", () => {
      const toggleMicrophone = vi.fn()
      renderAppRoom({
        participants: [localParticipant],
        localMicState: "live" as const,
        toggleMicrophone,
      })

      openAppInLauncher(screen, "test-app-1")
      expect(screen.getByTestId("room-app-iframe")).toBeInTheDocument()
      // The participant grid is gone, but Room voice and its control are not.
      expect(screen.queryByTestId("room-stage-participants")).toBeNull()
      expect(screen.getByTestId("room-stage")).toHaveAttribute(
        "data-stage-surface",
        "content"
      )
      expect(document.querySelector(".room-cosmos-sky")).toBeNull()
      const control = screen.getByTestId("room-mic-control")
      expect(control).toBeVisible()
      expect(control).toBeEnabled()
      fireEvent.click(control)
      expect(toggleMicrophone).toHaveBeenCalledTimes(1)
    })

    it("keeps the Room mic control reachable while a screen share owns the Stage", () => {
      const toggleMicrophone = vi.fn()
      renderAppRoom({
        participants: [localParticipant, remoteScreenShare],
        localMicState: "muted" as const,
        toggleMicrophone,
      })

      expect(screen.queryByTestId("room-stage-participants")).toBeNull()
      expect(screen.getByTestId("room-stage")).toHaveAttribute(
        "data-stage-surface",
        "content"
      )
      expect(document.querySelector(".room-cosmos-sky")).toBeNull()
      const control = screen.getByTestId("room-mic-control")
      expect(control).toBeVisible()
      expect(control).toHaveTextContent("Muted")
      fireEvent.click(control)
      expect(toggleMicrophone).toHaveBeenCalledTimes(1)
    })

    it("keeps a minimal Room mic control reachable in App fullscreen", () => {
      const toggleMicrophone = vi.fn()
      renderAppRoom({
        participants: [localParticipant],
        localMicState: "live" as const,
        toggleMicrophone,
      })

      openAppInLauncher(screen, "test-app-1")
      const host = slotHost("test-app-1")
      expect(
        screen.queryByTestId("room-mic-control-fullscreen")
      ).not.toBeInTheDocument()

      fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))

      // Focus mode hides the ordinary header on purpose, so the Room-owned
      // safety control must still be reachable without closing the App.
      expect(screen.getByTestId("room-mic-control")).not.toBeVisible()
      const fullscreenControl = screen.getByTestId(
        "room-mic-control-fullscreen"
      )
      expect(fullscreenControl).toBeVisible()
      expect(fullscreenControl).toBeEnabled()
      expect(fullscreenControl).toHaveTextContent("Mic")
      fireEvent.click(fullscreenControl)
      expect(toggleMicrophone).toHaveBeenCalledTimes(1)

      fireEvent.click(
        within(host).getByRole("button", { name: "Exit fullscreen" })
      )
      expect(
        screen.queryByTestId("room-mic-control-fullscreen")
      ).not.toBeInTheDocument()
      expect(screen.getByTestId("room-mic-control")).toBeVisible()
    })

    it("exits focus mode with Escape or Close while keeping the App resident", async () => {
      renderAppRoom()
      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
      expect(slotHidden("test-app-1")).toBe(false)
      expect(slotIframe("test-app-1")).toBe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("does not expand an inactive resident App and clears focus when Stage changes", async () => {
      renderAppRoom()
      openAppInLauncher(screen, "test-app-1")
      openAppInLauncher(screen, "test-app-2")

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

      openAppInLauncher(screen, "test-app-1")
      expect(appBHost).toHaveAttribute("data-layout", "stage")
      expect(slotHidden("test-app-2")).toBe(true)
      expect(slotHidden("test-app-1")).toBe(false)
    })

    it("keeps focus mode and the same iframe through a transient transport reconnect", async () => {
      const view = renderAppRoom()
      openAppInLauncher(screen, "test-app-1")
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
      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-2")
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

      openAppInLauncher(screen, "test-app-2")
      expect(slotHidden("test-app-2")).toBe(false)
      expect(slotIframe("test-app-2")).toBe(iframe)
      expect(channels).toHaveLength(1)
    })

    it("keeps one resident App while another is shown and restores the same iframe", async () => {
      renderAppRoom()

      openAppInLauncher(screen, "test-app-1")
      const appAIframe = slotIframe("test-app-1")
      loadAppIframe(appAIframe)
      const appAPort = channels[0].port1
      expect(channels).toHaveLength(1)

      openAppInLauncher(screen, "test-app-2")

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
      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(aliceView, "test-app-1")
      openAppInLauncher(bobView, "test-app-1")
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
      openAppInLauncher(aliceView, "test-app-1")
      openAppInLauncher(bobView, "test-app-1")
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
      openAppInLauncher(aliceView, "test-app-1")
      openAppInLauncher(bobView, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
      const frameWindow = loadAppIframe(slotIframe("test-app-1"))
      completeHandshake(frameWindow, "test-app-1", channels[0].port1)

      openAppInLauncher(screen, "test-app-1")
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
      openAppInLauncher(screen, "test-app-1")
      const iframe = slotIframe("test-app-1")
      loadAppIframe(iframe)

      fireEvent.click(screen.getByTestId("stage-view-live-view"))
      expect(slotHidden("test-app-1")).toBe(true)
      expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
      expect(screen.getByTestId("room-stage")).toHaveAttribute(
        "data-stage-surface",
        "content"
      )
      expect(document.querySelector(".room-cosmos-sky")).toBeNull()

      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
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
      openAppInLauncher(screen, "test-app-2")
      expect(await screen.findByTestId("room-app-host")).toBeInTheDocument()
      expect(screen.queryByTestId("stage-view-screen")).toBeNull()

      // Live View is likewise reachable on its own availability.
      fireEvent.click(screen.getByTestId("stage-view-live-view"))
      expect(slotHidden("test-app-2")).toBe(true)
      expect(screen.getByTestId("task-live-view")).toBeInTheDocument()
    })

    it("keeps hidden App slots non-interactive", async () => {
      renderAppRoom()

      openAppInLauncher(screen, "test-app-1")
      openAppInLauncher(screen, "test-app-2")

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

      openAppInLauncher(screen, "test-app-1")
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

      openAppInLauncher(screen, "test-app-1")
      openAppInLauncher(screen, "test-app-2")
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

      openAppInLauncher(screen, "test-app-1")
      openAppInLauncher(screen, "test-app-2")
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

    describe("#475 generated Task App Stage parity", () => {
      /** The canonical Room generation id the hook projects in RoomState. */
      const STAGE_ANALYTICS_ROOM_ID = "3f7c1c2e-9a4b-4d5e-8f01-2b6c7d8e9f10"
      const GENERATED_APP_ID = "generated:00000000-0000-4000-8000-0000000000a1"
      const generatedPublication = {
        appInstanceId: GENERATED_APP_ID,
        taskRequestId: "task-live",
        title: "Shared Counter",
        bundleBytes: 512,
        bundleRevision: 1,
        stateRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const generatedBundle = {
        version: 1 as const,
        manifest: { title: "Shared Counter", networkOrigins: [] as [] },
        html: "<main>count</main>",
        css: "main{}",
        js: "",
        initialState: { count: 0 },
      }
      const generatedDocument = {
        publication: generatedPublication,
        bundle: generatedBundle,
        state: { count: 0 },
      }
      const roomAuth = {
        roomId: "test-room",
        participantId: "human-local",
        token: "token",
      }

      /** Every generated-state listener, so both RoomContent and the host see it. */
      let generatedStateListeners: Array<
        (message: {
          appInstanceId: string
          revision: number
          state: Record<string, unknown>
          sourceParticipantId?: string
        }) => void
      > = []

      function emitGeneratedState(
        revision: number,
        state: Record<string, unknown>,
        sourceParticipantId?: string
      ) {
        act(() => {
          for (const listener of generatedStateListeners)
            listener({
              appInstanceId: GENERATED_APP_ID,
              revision,
              state,
              ...(sourceParticipantId === undefined
                ? {}
                : { sourceParticipantId }),
            })
        })
      }

      /**
       * One Room holding BOTH a curated Room App and a generated Task App —
       * exactly the production shape that painted two Stage hosts at once.
       */
      function renderBothAppRoom(overrides: Record<string, unknown> = {}) {
        generatedStateListeners = []
        const subscribeGeneratedAppState = vi.fn(
          (
            listener: (typeof generatedStateListeners)[number]
          ): (() => void) => {
            generatedStateListeners.push(listener)
            return () => undefined
          }
        )
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) =>
            String(input).includes("generated-app")
              ? new Response(JSON.stringify(generatedDocument), { status: 200 })
              : new Response(JSON.stringify(TEST_ROOM_APP_CATALOG_RESPONSE), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
          )
        )
        return renderAppRoom({
          getLocalRoomAuth: vi.fn(() => roomAuth),
          subscribeGeneratedAppState,
          messages: [taskRequestMessage],
          generatedApps: { [GENERATED_APP_ID]: generatedPublication },
          ...overrides,
        })
      }

      const generatedSlot = () =>
        screen.getByTestId(`generated-room-app-slot-${GENERATED_APP_ID}`)
      const generatedSlotHidden = () =>
        generatedSlot().className.includes("hidden")
      const generatedIframe = () =>
        within(generatedSlot()).getByTestId(
          "room-app-iframe"
        ) as HTMLIFrameElement
      const generatedHost = () =>
        within(generatedSlot()).getByTestId("room-app-host")

      /** Opens the generated Task App through the real product path. */
      async function openGeneratedStage() {
        // The catalog loads asynchronously in production mode before the Stage
        // switcher exists at all.
        await screen.findByTestId("stage-apps-launcher")
        fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
        fireEvent.click(await screen.findByTestId("stage-view-generated-app"))
        await waitFor(() =>
          expect(
            screen.getByTestId(`generated-room-app-slot-${GENERATED_APP_ID}`)
          ).toBeInTheDocument()
        )
      }

      /**
       * Loads the generated host's iframe and answers its bootstrap with the
       * generated app instance id (a curated `roomAppInstanceId` would be a
       * different identity and would never make this host ready).
       */
      function loadGeneratedApp() {
        const frameWindow = loadAppIframe(generatedIframe())
        const port = channels.at(-1)!.port1
        const bootstrap = frameWindow.postMessage.mock.calls[0][0]
        act(() => {
          port.emit({
            type: "ready",
            appInstanceId: GENERATED_APP_ID,
            handshakeToken: bootstrap.handshakeToken,
          })
        })
        return { frameWindow, port }
      }

      /** Selects the curated App through the real Stage strip/launcher path. */
      async function selectCuratedApp(appId = "test-app-1") {
        await screen.findByTestId("stage-apps-launcher")
        openAppInLauncher(screen, appId)
        await waitFor(() => expect(slotHidden(appId)).toBe(false))
      }

      /**
       * DOM layout truth: every Stage App slot that is NOT display:none and
       * NOT inert. Vertical stacking means this is > 1.
       */
      function visibleStageAppSlots(): HTMLElement[] {
        return screen
          .queryAllByTestId(/^(room-app-slot-|generated-room-app-slot-)/)
          .filter(
            (element) =>
              !element.className.includes("hidden") &&
              element.getAttribute("aria-hidden") !== "true" &&
              element.getAttribute("inert") !== "true"
          )
      }

      it("keeps exactly ONE Stage App visible across curated, generated, screen and live view", async () => {
        renderBothAppRoom()

        // Curated App owns the Stage.
        await selectCuratedApp()
        expect(
          visibleStageAppSlots().map((element) => element.dataset.testid)
        ).toEqual(["room-app-slot-test-app-1"])

        // Generated Task App takes it; the curated host stays resident but hidden.
        await openGeneratedStage()
        expect(generatedSlotHidden()).toBe(false)
        expect(slotHidden("test-app-1")).toBe(true)
        expect(
          visibleStageAppSlots().map((element) => element.dataset.testid)
        ).toEqual([`generated-room-app-slot-${GENERATED_APP_ID}`])
        // Resident, never destroyed.
        expect(slotIframe("test-app-1")).toBeInTheDocument()

        // Back to curated: the generated resident host hides; the curated one
        // is shown again without a new iframe.
        const curatedIframe = slotIframe("test-app-1")
        await selectCuratedApp()
        expect(generatedSlotHidden()).toBe(true)
        expect(
          visibleStageAppSlots().map((element) => element.dataset.testid)
        ).toEqual(["room-app-slot-test-app-1"])
        expect(slotIframe("test-app-1")).toBe(curatedIframe)

        // Generated again.
        await openGeneratedStage()
        expect(generatedSlotHidden()).toBe(false)
        expect(slotHidden("test-app-1")).toBe(true)
        expect(visibleStageAppSlots()).toHaveLength(1)
      })

      it("hides the generated host when Screen becomes the Stage surface", async () => {
        renderBothAppRoom({
          participants: [localParticipant, remoteScreenShare],
        })
        await openGeneratedStage()
        expect(generatedSlotHidden()).toBe(false)

        fireEvent.click(screen.getByTestId("stage-view-screen"))

        expect(generatedSlotHidden()).toBe(true)
        expect(visibleStageAppSlots()).toHaveLength(0)
        expect(screen.getByTestId("stage-view-screen")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      })

      it("hides the generated host when the Task Live View becomes the Stage surface", async () => {
        renderBothAppRoom({
          taskLiveViews: { "task-live": taskLiveViewSnapshot },
        })
        await openGeneratedStage()
        expect(generatedSlotHidden()).toBe(false)

        fireEvent.click(await screen.findByTestId("stage-view-live-view"))

        expect(generatedSlotHidden()).toBe(true)
        expect(visibleStageAppSlots()).toHaveLength(0)
        expect(screen.getByTestId("stage-view-live-view")).toHaveAttribute(
          "aria-pressed",
          "true"
        )
      })

      it("keeps the resident curated iframe and MessagePort across generated navigation", async () => {
        renderBothAppRoom()
        await selectCuratedApp()
        const iframe = slotIframe("test-app-1")
        completeHandshake(
          loadAppIframe(iframe),
          "test-app-1",
          channels[0].port1
        )
        const port = channels[0].port1

        await openGeneratedStage()
        await selectCuratedApp()

        expect(slotIframe("test-app-1")).toBe(iframe)
        expect(channels[0].port1).toBe(port)
        expect(port.close).not.toHaveBeenCalled()
        // The curated host is still reachable and still bound to its bridge.
        expect(slotHost("test-app-1")).toBeInTheDocument()
      })

      it("keeps the resident generated iframe across curated navigation", async () => {
        renderBothAppRoom()
        await openGeneratedStage()
        const iframe = generatedIframe()
        const { port } = loadGeneratedApp()

        await selectCuratedApp()
        expect(generatedIframe()).toBe(iframe)
        expect(port.close).not.toHaveBeenCalled()
      })

      it("gives a generated Task App working fullscreen with the shared Room focus contract", async () => {
        const view = renderBothAppRoom()
        await openGeneratedStage()
        const iframe = generatedIframe()
        loadGeneratedApp()
        const roomShell = document.querySelector(".room-shell")!
        const roomHeader = screen
          .getByTestId("room-header-identity")
          .closest("header")
        const chatPanel = screen
          .getByTestId("interaction-chat")
          .closest(".room-chat-panel")
        expect(generatedHost()).toHaveAttribute("data-layout", "stage")

        fireEvent.click(
          within(generatedSlot()).getByRole("button", { name: "Fullscreen" })
        )

        // Room-level focus mode, identical to a fullscreen curated App.
        expect(roomShell).toHaveAttribute("data-room-app-focus", "true")
        expect(generatedHost()).toHaveAttribute("data-layout", "fullscreen")
        expect(generatedHost()).toHaveClass("room-app-host--fullscreen")
        expect(roomHeader).not.toBeVisible()
        expect(roomHeader).toHaveAttribute("inert")
        expect(screen.getByTestId("stage-switcher")).not.toBeVisible()
        expect(screen.getByTestId("stage-switcher")).toHaveAttribute("inert")
        expect(screen.getByTestId("room-stage")).toHaveStyle({
          width: "100%",
        })
        expect(chatPanel).not.toBeVisible()
        expect(chatPanel).toHaveAttribute("inert")
        expect(
          screen.getByTestId("room-mic-control-fullscreen")
        ).toBeInTheDocument()
        // Focus mode never replaces the resident host.
        expect(generatedIframe()).toBe(iframe)

        // Exit fullscreen restores the ordinary split with the same host.
        fireEvent.click(
          within(generatedSlot()).getByRole("button", {
            name: "Exit fullscreen",
          })
        )
        expect(roomShell).not.toHaveAttribute("data-room-app-focus")
        expect(generatedHost()).toHaveAttribute("data-layout", "stage")
        expect(generatedIframe()).toBe(iframe)
        expect(screen.getByTestId("stage-switcher")).not.toHaveAttribute(
          "hidden"
        )
        view.unmount()
      })

      it("exits generated fullscreen with Escape", async () => {
        renderBothAppRoom()
        await openGeneratedStage()
        const roomShell = document.querySelector(".room-shell")!

        fireEvent.click(
          within(generatedSlot()).getByRole("button", { name: "Fullscreen" })
        )
        expect(roomShell).toHaveAttribute("data-room-app-focus", "true")

        act(() => {
          fireEvent.keyDown(window, { key: "Escape" })
        })
        expect(roomShell).not.toHaveAttribute("data-room-app-focus")
        expect(generatedSlotHidden()).toBe(false)
      })

      it("exits generated fullscreen safely when another Stage surface is selected", async () => {
        renderBothAppRoom()
        await openGeneratedStage()
        const roomShell = document.querySelector(".room-shell")!
        fireEvent.click(
          within(generatedSlot()).getByRole("button", { name: "Fullscreen" })
        )
        expect(roomShell).toHaveAttribute("data-room-app-focus", "true")

        await selectCuratedApp()

        expect(roomShell).not.toHaveAttribute("data-room-app-focus")
        expect(slotHidden("test-app-1")).toBe(false)
        expect(generatedSlotHidden()).toBe(true)
        expect(
          visibleStageAppSlots().map((element) => element.dataset.testid)
        ).toEqual(["room-app-slot-test-app-1"])
      })

      it("exits generated fullscreen when its own host is closed", async () => {
        renderBothAppRoom()
        await openGeneratedStage()
        const roomShell = document.querySelector(".room-shell")!
        fireEvent.click(
          within(generatedSlot()).getByRole("button", { name: "Fullscreen" })
        )
        expect(roomShell).toHaveAttribute("data-room-app-focus", "true")

        fireEvent.click(
          within(generatedSlot()).getByRole("button", { name: "Close" })
        )

        expect(roomShell).not.toHaveAttribute("data-room-app-focus")
        expect(generatedSlotHidden()).toBe(true)
      })

      it("reports generated engagement only for this browser's accepted App interaction", async () => {
        vi.stubEnv("NODE_ENV", "production")
        const analyticsSpy = vi.mocked(trackAnalyticsEvent)
        analyticsSpy.mockClear()
        renderBothAppRoom({
          analyticsRoomId: STAGE_ANALYTICS_ROOM_ID,
        })
        await openGeneratedStage()
        loadGeneratedApp()

        const engaged = () =>
          analyticsSpy.mock.calls.filter(
            ([event]) => event === "RoomAppEngaged"
          )
        // A mount, a ready handshake and hydration are not engagement.
        expect(engaged()).toHaveLength(0)

        // Another Human's accepted change is not THIS browser's engagement.
        emitGeneratedState(1, { count: 1 }, "human-b")
        expect(engaged()).toHaveLength(0)

        // A revision-less reconciliation carries no source at all.
        emitGeneratedState(2, { count: 2 })
        expect(engaged()).toHaveLength(0)

        // This Human's own accepted mutation is the engagement boundary.
        emitGeneratedState(3, { count: 3 }, "human-local")
        expect(engaged()).toHaveLength(1)
        expect(engaged()[0][1]).toEqual({
          appSource: "generated",
          participantsBucket: "1",
          analyticsRoomId: STAGE_ANALYTICS_ROOM_ID,
        })

        // Further local interactions never re-report for this resident App.
        emitGeneratedState(4, { count: 4 }, "human-local")
        emitGeneratedState(5, { count: 5 }, "human-local")
        expect(engaged()).toHaveLength(1)

        // No instance id, Task id, Room name, state payload, revision, or
        // participant id ever reaches analytics.
        const serialized = JSON.stringify(engaged())
        expect(serialized).not.toContain(GENERATED_APP_ID)
        expect(serialized).not.toContain("task-live")
        expect(serialized).not.toContain("test-room")
        expect(serialized).not.toContain("count")
        expect(serialized).not.toContain("human-local")
        expect(serialized).not.toContain("human-b")
        expect(Object.keys(engaged()[0][1]).sort()).toEqual([
          "analyticsRoomId",
          "appSource",
          "participantsBucket",
        ])
      })

      it("keeps the curated engagement milestone and the generated family distinct", async () => {
        vi.stubEnv("NODE_ENV", "production")
        const analyticsSpy = vi.mocked(trackAnalyticsEvent)
        analyticsSpy.mockClear()
        renderBothAppRoom()

        // Curated App: the existing `milestone: engaged` bridge still works.
        await selectCuratedApp()
        const curatedIframe = slotIframe("test-app-1")
        completeHandshake(
          loadAppIframe(curatedIframe),
          "test-app-1",
          channels[0].port1
        )
        act(() => {
          channels[0].port1.emit({
            type: "milestone",
            appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
            milestone: "engaged",
          })
        })
        const engagedCalls = analyticsSpy.mock.calls.filter(
          ([event]) => event === "RoomAppEngaged"
        )
        expect(engagedCalls).toHaveLength(1)
        expect(engagedCalls[0][1]).toMatchObject({ app: "test-app-1" })

        // The generated App reports through the SAME event family, never a
        // parallel taxonomy.
        await openGeneratedStage()
        loadGeneratedApp()
        emitGeneratedState(1, { count: 1 }, "human-local")

        const all = analyticsSpy.mock.calls.filter(
          ([event]) => event === "RoomAppEngaged"
        )
        expect(all).toHaveLength(2)
        expect(all[1][1]).toMatchObject({ appSource: "generated" })
        const names = new Set(analyticsSpy.mock.calls.map(([event]) => event))
        for (const forbidden of [
          "GeneratedAppEngaged",
          "TaskAppClicked",
          "GeneratedStateChanged",
        ])
          expect(names.has(forbidden)).toBe(false)
      })

      it("keeps the generated shared-session milestone unchanged", async () => {
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
        const view = renderBothAppRoom()
        await openGeneratedStage()
        loadGeneratedApp()
        expect(
          analyticsSpy.mock.calls.filter(
            ([event]) => event === "RoomAppSharedSession"
          )
        ).toHaveLength(0)

        mockUseSfuChatRoom.mockReturnValue({
          ...baseHookReturn,
          connectionStatus: "connected",
          roomAppsEnabled: true,
          getLocalRoomAuth: vi.fn(() => roomAuth),
          subscribeGeneratedState: vi.fn(() => () => undefined),
          participants: [localParticipant, remoteHuman],
          messages: [taskRequestMessage],
          generatedApps: { [GENERATED_APP_ID]: generatedPublication },
        })
        view.rerender(
          <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
        )

        await waitFor(() =>
          expect(
            analyticsSpy.mock.calls.filter(
              ([event]) => event === "RoomAppSharedSession"
            )
          ).toHaveLength(1)
        )
        expect(
          analyticsSpy.mock.calls.find(
            ([event]) => event === "RoomAppSharedSession"
          )?.[1]
        ).toEqual({ appSource: "generated", participantsBucket: "2-3" })
      })
    })
    describe("#134 acquisitionPage on Host-owned events", () => {
      /** Render the same Room with the acquisition context the Room page resolved. */
      function renderAcquiredRoom(
        acquisitionPage?: string,
        overrides: Record<string, unknown> = {}
      ) {
        mockUseSfuChatRoom.mockReturnValue({
          ...baseHookReturn,
          connectionStatus: "connected",
          roomAppsEnabled: true,
          participants: [localParticipant],
          ...overrides,
        })
        return render(
          <RoomContent
            roomName="test-room"
            nickName="Alice"
            roomType="audio"
            initialRoomAppId="test-app-1"
            acquisitionPage={acquisitionPage}
          />
        )
      }

      /** The recorded payload of one analytics event, key-for-key exact. */
      function trackedEvent(eventName: string) {
        const call = vi
          .mocked(trackAnalyticsEvent)
          .mock.calls.filter(([name]) => name === eventName)
          .at(-1)
        expect(call, `${eventName} must be tracked`).toBeDefined()
        return call?.[1] as Record<string, unknown>
      }

      it("carries the acquired slug on Mounted, Engaged and SharedSession while the App id stays current", async () => {
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
        const view = renderAcquiredRoom("typing-race")

        const iframe = (await screen.findByTestId(
          "room-app-iframe"
        )) as HTMLIFrameElement
        completeHandshake(
          loadAppIframe(iframe),
          "test-app-1",
          channels[0].port1
        )

        expect(trackedEvent("RoomAppMounted")).toEqual({
          app: "test-app-1",
          acquisitionPage: "typing-race",
        })

        act(() => {
          channels[0].port1.emit({
            type: "milestone",
            appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
            milestone: "engaged",
          })
        })
        expect(trackedEvent("RoomAppEngaged")).toEqual({
          app: "test-app-1",
          participantsBucket: "1",
          acquisitionPage: "typing-race",
        })

        // A second Human satisfies the shared-use milestone for the acquired
        // Room; the App id and bucket stay the current ones.
        view.rerender(
          <RoomContent
            roomName="test-room"
            nickName="Alice"
            roomType="audio"
            initialRoomAppId="test-app-1"
            acquisitionPage="typing-race"
          />
        )
        mockUseSfuChatRoom.mockReturnValue({
          ...baseHookReturn,
          connectionStatus: "connected",
          roomAppsEnabled: true,
          participants: [localParticipant, remoteHuman],
        })
        view.rerender(
          <RoomContent
            roomName="test-room"
            nickName="Alice"
            roomType="audio"
            initialRoomAppId="test-app-1"
            acquisitionPage="typing-race"
          />
        )
        await waitFor(() =>
          expect(trackedEvent("RoomAppSharedSession")).toEqual({
            app: "test-app-1",
            participantsBucket: "2-3",
            acquisitionPage: "typing-race",
          })
        )
        // No participant identity or Room content is added to the event.
        expect(
          Object.keys(trackedEvent("RoomAppSharedSession")).sort()
        ).toEqual(["acquisitionPage", "app", "participantsBucket"])
      })

      it("keeps the original acquisitionPage when the Room switches to another App", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.mocked(trackAnalyticsEvent).mockClear()
        renderAcquiredRoom("random-teams")
        await screen.findByTestId("stage-app-test-app-1")

        // The Room had already switched: RoomContent now mounts test-app-2 while
        // the acquisition intent remains the landing that acquired the Room.
        openAppInLauncher(screen, "test-app-2")
        const iframe = slotIframe("test-app-2") as HTMLIFrameElement
        completeHandshake(
          loadAppIframe(iframe),
          "test-app-2",
          channels[channels.length - 1].port1
        )

        expect(trackedEvent("RoomAppMounted")).toEqual({
          app: "test-app-2",
          acquisitionPage: "random-teams",
        })
      })

      it("preserves the exact existing event shape when no acquisition context exists", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.mocked(trackAnalyticsEvent).mockClear()
        renderAcquiredRoom(undefined)

        const iframe = (await screen.findByTestId(
          "room-app-iframe"
        )) as HTMLIFrameElement
        completeHandshake(
          loadAppIframe(iframe),
          "test-app-1",
          channels[0].port1
        )

        act(() => {
          channels[0].port1.emit({
            type: "milestone",
            appInstanceId: roomAppInstanceId("test-room", "test-app-1"),
            milestone: "engaged",
          })
        })

        expect(trackedEvent("RoomAppMounted")).toEqual({ app: "test-app-1" })
        expect(Object.keys(trackedEvent("RoomAppMounted"))).toEqual(["app"])
        expect(trackedEvent("RoomAppEngaged")).toEqual({
          app: "test-app-1",
          participantsBucket: "1",
        })
        // A direct launch invents no category rather than sending undefined.
        expect(Object.keys(trackedEvent("RoomAppEngaged")).sort()).toEqual([
          "app",
          "participantsBucket",
        ])
      })

      it("carries the acquired slug on RoomActivated", async () => {
        vi.stubEnv("NODE_ENV", "production")
        const analyticsSpy = vi.mocked(trackAnalyticsEvent)
        analyticsSpy.mockClear()
        const catalogLoader = vi
          .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
          .mockResolvedValue(TEST_ROOM_APP_CATALOG)
        vi.useFakeTimers()
        const remoteHuman = {
          peerId: "human-b",
          name: "Bob",
          kind: "human",
          room: "test-room",
          muteState: false,
        }
        let view: ReturnType<typeof render> | undefined
        try {
          view = renderAcquiredRoom("typing-race", {
            participants: [localParticipant, remoteHuman],
          })
          await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
          })
          expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
            "RoomActivated",
            expect.anything()
          )

          await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000)
          })
        } finally {
          view?.unmount()
          vi.useRealTimers()
          catalogLoader.mockRestore()
        }

        expect(trackedEvent("RoomActivated")).toEqual({
          roomType: "audio",
          participantBucket: "2-3",
          activationDelaySeconds: 30,
          acquisitionPage: "typing-race",
          // #346 same-browser repeat-use direction. This browser remembers no
          // prior Rooms, so the truthful answer is "no prior use".
          returningBrowser: false,
          priorRoomCountBucket: "0",
        })
        // Existing RoomActivated properties are untouched; only the bounded
        // acquisition intent and the coarse browser-local repeat-use
        // direction are added.
        expect(Object.keys(trackedEvent("RoomActivated")).sort()).toEqual([
          "acquisitionPage",
          "activationDelaySeconds",
          "participantBucket",
          "priorRoomCountBucket",
          "returningBrowser",
          "roomType",
        ])
      })

      it("omits acquisitionPage from RoomActivated for a direct Room entry", async () => {
        vi.stubEnv("NODE_ENV", "production")
        const analyticsSpy = vi.mocked(trackAnalyticsEvent)
        analyticsSpy.mockClear()
        const catalogLoader = vi
          .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
          .mockResolvedValue(TEST_ROOM_APP_CATALOG)
        vi.useFakeTimers()
        const remoteHuman = {
          peerId: "human-b",
          name: "Bob",
          kind: "human",
          room: "test-room",
          muteState: false,
        }
        let view: ReturnType<typeof render> | undefined
        try {
          view = renderAcquiredRoom(undefined, {
            participants: [localParticipant, remoteHuman],
          })
          await act(async () => {
            await Promise.resolve()
            await Promise.resolve()
          })
          await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000)
          })
        } finally {
          view?.unmount()
          vi.useRealTimers()
          catalogLoader.mockRestore()
        }

        expect(trackedEvent("RoomActivated")).toEqual({
          roomType: "audio",
          participantBucket: "2-3",
          activationDelaySeconds: 30,
          returningBrowser: false,
          priorRoomCountBucket: "0",
        })
        expect(Object.keys(trackedEvent("RoomActivated")).sort()).toEqual([
          "activationDelaySeconds",
          "participantBucket",
          "priorRoomCountBucket",
          "returningBrowser",
          "roomType",
        ])
      })
    })
  })

  describe("#346 Room-scoped browser analytics correlation", () => {
    const ROOM_ID = "3f7c1c2e-9a4b-4d5e-8f01-2b6c7d8e9f10"
    const localParticipant = {
      peerId: "local-peer",
      name: "Alice",
      kind: "human",
      room: "test-room",
      muteState: false,
    }

    /** The recorded payload of one analytics event, key-for-key exact. */
    function trackedEvent(eventName: string, index = -1) {
      const calls = vi
        .mocked(trackAnalyticsEvent)
        .mock.calls.filter(([name]) => name === eventName)
      const call = index < 0 ? calls.at(index) : calls[index]
      expect(call, `${eventName} must be tracked`).toBeDefined()
      return call?.[1] as Record<string, unknown>
    }

    it("carries the canonical Room generation id on every Room-scoped event", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const analyticsSpy = vi.mocked(trackAnalyticsEvent)
      analyticsSpy.mockClear()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValue(TEST_ROOM_APP_CATALOG)
      const remoteHuman = {
        peerId: "human-b",
        name: "Bob",
        kind: "human",
        room: "test-room",
        muteState: false,
      }
      vi.useFakeTimers()
      let view: ReturnType<typeof render> | undefined
      try {
        mockUseSfuChatRoom.mockReturnValue({
          ...baseHookReturn,
          connectionStatus: "connected",
          roomAppsEnabled: true,
          analyticsRoomId: ROOM_ID,
          participants: [localParticipant, remoteHuman],
        })
        view = render(
          <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
        )
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000)
        })
      } finally {
        view?.unmount()
        vi.useRealTimers()
        catalogLoader.mockRestore()
      }

      // RoomActivated: the canonical id rides alongside the existing
      // properties and the coarse browser-local repeat-use direction.
      expect(trackedEvent("RoomActivated")).toEqual({
        roomType: "audio",
        participantBucket: "2-3",
        activationDelaySeconds: 30,
        returningBrowser: false,
        priorRoomCountBucket: "0",
        analyticsRoomId: ROOM_ID,
      })

      // AgentInviteCopied is Room-scoped too, and gets the SAME id. It is
      // rendered in its own real-timer mount so the idle 30s activation
      // window cannot interfere with the clipboard interaction.
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      const inviteView = render(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
      fireEvent.click(
        screen.getByRole("button", { name: "Copy invite prompt" })
      )
      await waitFor(() =>
        expect(trackedEvent("AgentInviteCopied")).toEqual({
          surface: "room",
          roomType: "audio",
          analyticsRoomId: ROOM_ID,
        })
      )
      inviteView.unmount()
    })

    it("never fabricates a correlation id before authoritative Room state exists", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const analyticsSpy = vi.mocked(trackAnalyticsEvent)
      analyticsSpy.mockClear()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValue(TEST_ROOM_APP_CATALOG)
      const remoteHuman = {
        peerId: "human-b",
        name: "Bob",
        kind: "human",
        room: "test-room",
        muteState: false,
      }
      vi.useFakeTimers()
      let view: ReturnType<typeof render> | undefined
      try {
        // No analyticsRoomId: the server has not projected Room state yet.
        mockUseSfuChatRoom.mockReturnValue({
          ...baseHookReturn,
          connectionStatus: "connected",
          roomAppsEnabled: true,
          participants: [localParticipant, remoteHuman],
        })
        view = render(
          <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
        )
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000)
        })
      } finally {
        view?.unmount()
        vi.useRealTimers()
        catalogLoader.mockRestore()
      }

      const payload = trackedEvent("RoomActivated")
      expect(payload).not.toHaveProperty("analyticsRoomId")
      expect(Object.keys(payload).sort()).toEqual([
        "activationDelaySeconds",
        "participantBucket",
        "priorRoomCountBucket",
        "returningBrowser",
        "roomType",
      ])
    })
  })

  it("keeps official Apps in the launcher and a generated Task App on the selected Task surface", () => {
    const generatedPublication = {
      appInstanceId: "generated:00000000-0000-4000-8000-000000000001",
      taskRequestId: "task-live",
      title: "Generated Checklist",
      bundleBytes: 512,
      bundleRevision: 1,
      stateRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      roomAppsEnabled: true,
      participants: [
        {
          peerId: "local-peer",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-a",
          name: "Agent A",
          kind: "agent",
          room: "test-room",
        },
      ],
      messages: [taskRequestMessage],
      generatedApps: {
        [generatedPublication.appInstanceId]: generatedPublication,
      },
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))

    expect(screen.getByTestId("generated-room-app-card")).toHaveTextContent(
      "Task App"
    )
    expect(screen.getByText("Generated Checklist")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("stage-apps-launcher"))
    const launcher = screen.getByTestId("room-app-launcher")
    expect(launcher).toHaveTextContent("Test App 1")
    expect(launcher).not.toHaveTextContent("Generated Checklist")
    fireEvent.click(screen.getByTestId("stage-view-generated-app"))
    expect(screen.getByTestId("stage-view-generated-app")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("reconciles generated state after a missed event and refetches state-only updates", async () => {
    const publication = {
      appInstanceId: "generated:00000000-0000-4000-8000-000000000002",
      taskRequestId: "task-live",
      title: "Checklist",
      bundleBytes: 512,
      bundleRevision: 1,
      stateRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const bundle = {
      version: 1 as const,
      manifest: { title: "Checklist", networkOrigins: [] as [] },
      html: "<main></main>",
      css: "main{}",
      js: "",
      initialState: { items: [] },
    }
    const documentAtRevision = (stateRevision: number, items: string[]) => ({
      publication: { ...publication, stateRevision },
      bundle,
      state: { items },
    })
    let resolveInitial!: (response: Response) => void
    const initialResponse = new Promise<Response>((resolve) => {
      resolveInitial = resolve
    })
    const fetchGenerated = vi
      .fn()
      .mockReturnValueOnce(initialResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(documentAtRevision(2, ["first", "second"])),
          { status: 200 }
        )
      )
    vi.stubGlobal("fetch", fetchGenerated)
    let generatedStateListener:
      | ((message: {
          appInstanceId: string
          revision: number
          state: Record<string, unknown>
        }) => void)
      | undefined
    const subscribeGeneratedAppState = vi.fn(
      (listener: typeof generatedStateListener) => {
        generatedStateListener = listener
        return () => undefined
      }
    )
    const auth = {
      roomId: "test-room",
      participantId: "human-a",
      token: "token",
    }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      roomAppsEnabled: true,
      getLocalRoomAuth: vi.fn(() => auth),
      subscribeGeneratedAppState,
      participants: [
        {
          peerId: "local-peer",
          name: "Alice",
          kind: "human",
          room: "test-room",
        },
        {
          peerId: "agent-a",
          name: "Agent",
          kind: "agent",
          room: "test-room",
        },
      ],
      messages: [taskRequestMessage],
      generatedApps: {
        [publication.appInstanceId]: publication,
      },
    })
    const view = render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
    fireEvent.click(screen.getByTestId("stage-view-generated-app"))
    await waitFor(() => expect(fetchGenerated).toHaveBeenCalledTimes(1))

    // The state event arrives before the initial GET. It must be retained
    // rather than dropped and must win over the older GET response.
    act(() => {
      generatedStateListener?.({
        appInstanceId: publication.appInstanceId,
        revision: 1,
        state: { items: ["first"] },
      })
    })
    resolveInitial(
      new Response(JSON.stringify(documentAtRevision(0, [])), { status: 200 })
    )
    await waitFor(() =>
      expect(screen.getByTestId("room-app-iframe")).toBeInTheDocument()
    )
    expect(screen.getByTestId("room-stage")).toHaveAttribute(
      "data-stage-surface",
      "content"
    )
    expect(document.querySelector(".room-cosmos-sky")).toBeNull()
    const iframe = screen.getByTestId("room-app-iframe")
    expect(fetchGenerated).toHaveBeenCalledTimes(1)

    // A later Room projection with the same bundle but a higher state revision
    // triggers a canonical GET without changing the resident iframe identity.
    const nextPublication = { ...publication, stateRevision: 2 }
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      roomAppsEnabled: true,
      getLocalRoomAuth: vi.fn(() => auth),
      subscribeGeneratedAppState,
      participants: [
        {
          peerId: "local-peer",
          name: "Alice",
          kind: "human",
          room: "test-room",
        },
        {
          peerId: "agent-a",
          name: "Agent",
          kind: "agent",
          room: "test-room",
        },
      ],
      messages: [taskRequestMessage],
      generatedApps: { [publication.appInstanceId]: nextPublication },
    })
    view.rerender(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )
    await waitFor(() => expect(fetchGenerated).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId("room-app-iframe")).toBe(iframe)
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

  /**
   * #98: the in-Room App strip must scale by progressive disclosure. These hold
   * the product line the launcher exists for: Room first, a bounded recent set
   * second, the whole promoted catalog one lightweight action away.
   */
  describe("Room App launcher (#98)", () => {
    const localParticipant = {
      peerId: "local-peer",
      name: "Alice",
      kind: "human" as const,
      room: "test-room",
      muteState: "unmuted" as const,
      audioStream: null,
      screenShareStream: null,
      screenShareEnabled: false,
      voiceAvailable: false,
      voiceEnabled: false,
    }

    function renderAppRoom(
      overrides: Record<string, unknown> = {},
      roomId = "test-room"
    ) {
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
        ...overrides,
      })
      return render(
        <RoomContent roomName={roomId} nickName="Alice" roomType="audio" />
      )
    }

    const recentsKey = (roomId: string) =>
      `free4chat:room-app-recents:v1:${roomId}`

    const storedRecents = (roomId: string) =>
      window.sessionStorage.getItem(recentsKey(roomId))

    function seedRecents(roomId: string, appIds: string[]) {
      window.sessionStorage.setItem(recentsKey(roomId), JSON.stringify(appIds))
    }

    function openLauncher() {
      fireEvent.click(screen.getByTestId("stage-apps-launcher"))
    }

    /**
     * One Lab catalog revision, parsed by the same parser the browser loader
     * runs, so a refresh reaches RoomContent as brand-new objects.
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

    /**
     * jsdom cannot lay the Room out, so this only proves the strip is a local
     * scroller rather than a page-widening row; the real viewport geometry is
     * asserted in the Playwright compatibility gate.
     */
    function pageOverflowFree(): boolean {
      const strip = screen.getByTestId("stage-switcher")
      return strip.className.includes("overflow-x-auto")
    }

    /** Inline chip ids in the strip's actual reading order. */
    function inlineChipIds(): string[] {
      return Array.from(
        document.querySelectorAll('button[data-testid^="stage-app-"]')
      )
        .map((chip) => chip.getAttribute("data-testid")!)
        .filter((testId) => testId.startsWith("stage-app-"))
        .map((testId) => testId.slice("stage-app-".length))
    }

    it("keeps every App discoverable without handing the strip the whole catalog", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()

      await screen.findByTestId("stage-apps-launcher")
      // A fresh Room stays minimal: the launcher is the only App entry, and
      // nothing is inline until something is actually opened.
      expect(inlineChipIds()).toEqual([])
      // The Room itself is on screen the whole time — Apps never replace it.
      expect(screen.getByTestId("room-stage-participants")).toBeInTheDocument()
      expect(pageOverflowFree()).toBe(true)

      openLauncher()
      for (const app of TEST_ROOM_APP_CATALOG)
        expect(screen.getByTestId(`launcher-app-${app.id}`)).toBeInTheDocument()

      // Picking an App is one action: the launcher closes on selection and the
      // App becomes the current Stage surface without any strip archaeology.
      fireEvent.click(screen.getByTestId("launcher-app-test-app-6"))
      expect(screen.queryByTestId("room-app-launcher")).toBeNull()
      expect(screen.getByTestId("stage-app-test-app-6")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      // Leaving the Stage is still one action through the host chrome, and it
      // returns to the Room surface without destroying the resident App.
      fireEvent.click(
        within(screen.getByTestId("room-app-host")).getByRole("button", {
          name: "Close",
        })
      )
      expect(
        screen.getByTestId("room-app-slot-test-app-6").className
      ).toContain("hidden")
      expect(screen.getByTestId("stage-app-test-app-6")).toHaveAttribute(
        "aria-pressed",
        "false"
      )
      expect(screen.getByTestId("stage-apps-launcher")).toBeInTheDocument()
    })

    it("bounds the inline strip by recency and never duplicates an App", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")

      for (const id of [
        "test-app-1",
        "test-app-2",
        "test-app-3",
        "test-app-2",
      ]) {
        openLauncher()
        fireEvent.click(screen.getByTestId(`launcher-app-${id}`))
      }

      // Most recent first, no duplicates, strictly bounded: the current App
      // plus the two Apps opened before it, and test-app-1 is gone.
      expect(inlineChipIds()).toEqual([
        "test-app-2",
        "test-app-3",
        "test-app-1",
      ])
      expect(inlineChipIds()).not.toContain("test-app-4")
      expect(inlineChipIds().length).toBeLessThanOrEqual(
        ROOM_APP_INLINE_SHORTCUTS_DESKTOP
      )
    })

    it("remembers recency for this browser tab only, namespaced by Room", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")
      openLauncher()
      fireEvent.click(screen.getByTestId("launcher-app-test-app-4"))

      const stored = Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith("free4chat:room-app-recents")
      )
      expect(stored).toHaveLength(1)
      expect(stored[0]).toContain("test-room")
      expect(window.sessionStorage.getItem(stored[0])).toContain("test-app-4")
      // No durable preference, account or favorite of any kind.
      expect(window.localStorage.length).toBe(0)
    })

    it("hydrates this Room's stored recents without erasing them first", async () => {
      vi.stubEnv("NODE_ENV", "production")
      seedRecents("test-room", ["test-app-4", "test-app-2"])

      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")

      // The regression: persisting the empty initial state used to delete the
      // key before hydration could read it, so nothing ever survived a reload.
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-2"])
      )
      // And the hydrated list is what the UI and the launcher actually show:
      // both remembered Apps are inline (no App is open, so nothing is
      // prepended) and both are offered under "Recent in this Room".
      expect(inlineChipIds()).toEqual(["test-app-4", "test-app-2"])
      openLauncher()
      const recentSection = within(
        screen.getByTestId("room-app-launcher-recent")
      )
      expect(
        recentSection.getByTestId("launcher-app-test-app-4")
      ).toBeInTheDocument()
      expect(
        recentSection.getByTestId("launcher-app-test-app-2")
      ).toBeInTheDocument()
    })

    it("keeps recents across an unmount and remount of the same Room", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const first = renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")
      openLauncher()
      fireEvent.click(screen.getByTestId("launcher-app-test-app-5"))
      expect(storedRecents("test-room")).toBe(JSON.stringify(["test-app-5"]))
      first.unmount()

      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")

      expect(storedRecents("test-room")).toBe(JSON.stringify(["test-app-5"]))
      expect(inlineChipIds()).toEqual(["test-app-5"])
      openLauncher()
      expect(
        within(screen.getByTestId("room-app-launcher-recent")).getByTestId(
          "launcher-app-test-app-5"
        )
      ).toBeInTheDocument()
    })

    it("keeps each Room's recents independent in the same browser tab", async () => {
      vi.stubEnv("NODE_ENV", "production")
      seedRecents("test-room", ["test-app-4", "test-app-2"])
      seedRecents("other-room", ["test-app-6"])

      const roomA = renderAppRoom({}, "test-room")
      await screen.findByTestId("stage-apps-launcher")
      expect(inlineChipIds()).toEqual(["test-app-4", "test-app-2"])
      roomA.unmount()

      // Room B must not inherit Room A's list, and must respect its own.
      renderAppRoom({}, "other-room")
      await screen.findByTestId("stage-apps-launcher")
      expect(inlineChipIds()).toEqual(["test-app-6"])
      expect(storedRecents("other-room")).toBe(JSON.stringify(["test-app-6"]))
      // Room A's entry is untouched by Room B's lifecycle.
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-2"])
      )
    })

    it("persists the updated recent order after an App opens following hydration", async () => {
      vi.stubEnv("NODE_ENV", "production")
      seedRecents("test-room", ["test-app-4", "test-app-2"])

      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-2"])
      )

      openLauncher()
      fireEvent.click(screen.getByTestId("launcher-app-test-app-3"))
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-3", "test-app-4", "test-app-2"])
      )

      // Reopening an already-recent App only reorders: still no duplicates.
      openLauncher()
      fireEvent.click(screen.getByTestId("launcher-app-test-app-4"))
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-3", "test-app-2"])
      )
      expect(inlineChipIds()).toEqual([
        "test-app-4",
        "test-app-3",
        "test-app-2",
      ])
      expect(inlineChipIds().length).toBeLessThanOrEqual(
        ROOM_APP_INLINE_SHORTCUTS_DESKTOP
      )
    })

    it("does not erase recents while Room Apps are transiently unavailable", async () => {
      vi.stubEnv("NODE_ENV", "production")
      seedRecents("test-room", ["test-app-4", "test-app-2"])

      const view = renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-2"])
      )

      // `roomAppsEnabled` also drops during an ordinary SFU/media reconnect.
      // An empty available-App set is NOT "every remembered App was retired":
      // in the real browser this erased the tab's recents.
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: false,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-2"])
      )

      // Apps come back: the same remembered order is still there.
      mockUseSfuChatRoom.mockReturnValue({
        ...baseHookReturn,
        connectionStatus: "connected",
        roomAppsEnabled: true,
        participants: [localParticipant],
      })
      view.rerender(
        <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
      )
      expect(storedRecents("test-room")).toBe(
        JSON.stringify(["test-app-4", "test-app-2"])
      )
      expect(inlineChipIds()).toEqual(["test-app-4", "test-app-2"])
    })

    it("does not write any Room recents entry before a Room is bound", async () => {
      vi.stubEnv("NODE_ENV", "production")
      seedRecents("test-room", ["test-app-4"])
      renderAppRoom({}, "")
      await act(async () => {
        await Promise.resolve()
      })
      // An unbound Room hydrates nothing and erases nothing.
      expect(storedRecents("test-room")).toBe(JSON.stringify(["test-app-4"]))
    })

    it("filters the catalog by text and explains an empty search", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")
      openLauncher()

      const search = screen.getByTestId("room-app-search")
      fireEvent.change(search, { target: { value: "test app 1" } })
      expect(screen.getByTestId("launcher-app-test-app-1")).toBeInTheDocument()
      expect(screen.queryByTestId("launcher-app-test-app-2")).toBeNull()

      fireEvent.change(search, { target: { value: "nothing here" } })
      expect(screen.getByTestId("room-app-search-empty")).toBeInTheDocument()
      expect(screen.queryByTestId("launcher-app-test-app-1")).toBeNull()
    })

    it("opens, searches, selects and closes with the keyboard alone", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()
      const launcherEntry = await screen.findByTestId("stage-apps-launcher")

      // Opening moves focus into search so no pointer is needed.
      launcherEntry.focus()
      fireEvent.click(launcherEntry)
      const search = screen.getByTestId("room-app-search")
      expect(document.activeElement).toBe(search)

      fireEvent.change(search, { target: { value: "test app 3" } })
      fireEvent.keyDown(search, { key: "Enter" })
      expect(screen.queryByTestId("room-app-launcher")).toBeNull()
      expect(screen.getByTestId("stage-app-test-app-3")).toHaveAttribute(
        "aria-pressed",
        "true"
      )

      // Escape closes an open launcher without changing the current App.
      openLauncher()
      fireEvent.keyDown(screen.getByTestId("room-app-search"), {
        key: "Escape",
      })
      expect(screen.queryByTestId("room-app-launcher")).toBeNull()
      expect(screen.getByTestId("stage-app-test-app-3")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    })

    it("keeps an outside click closing the launcher without stealing the Room", async () => {
      vi.stubEnv("NODE_ENV", "production")
      renderAppRoom()
      await screen.findByTestId("stage-apps-launcher")
      openLauncher()
      expect(screen.getByTestId("room-app-launcher")).toBeInTheDocument()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByTestId("room-app-launcher")).toBeNull()
      expect(screen.getByTestId("stage-apps-launcher")).toBeInTheDocument()
    })

    it("retires a catalog-removed App from recency instead of showing a dead chip", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce(TEST_ROOM_APP_CATALOG)
        .mockResolvedValue(
          catalogRevision({ remove: ["test-app-1", "test-app-2"] })
        )
      let view: ReturnType<typeof render> | undefined
      try {
        view = renderAppRoom()
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        openLauncher()
        fireEvent.click(screen.getByTestId("launcher-app-test-app-1"))
        // Selecting closes the launcher, so each pick reopens it.
        openLauncher()
        fireEvent.click(screen.getByTestId("launcher-app-test-app-2"))
        expect(inlineChipIds()).toEqual(["test-app-2", "test-app-1"])

        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        expect(inlineChipIds()).toEqual([])
        openLauncher()
        expect(screen.queryByTestId("launcher-app-test-app-1")).toBeNull()
        expect(screen.queryByTestId("launcher-app-test-app-2")).toBeNull()
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })

    it("keeps a catalog-maximum label from breaking the strip", async () => {
      vi.stubEnv("NODE_ENV", "production")
      // The Lab catalog allows labels up to 64 characters: a long real-world
      // label must not widen the Room layout.
      const longLabel = `${"Very Long App Label ".repeat(4)}`.slice(0, 64)
      expect(longLabel).toHaveLength(64)
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValue(
          catalogRevision({ relabel: { "test-app-1": longLabel } })
        )
      try {
        renderAppRoom()
        await screen.findByTestId("stage-apps-launcher")
        openLauncher()
        fireEvent.click(screen.getByTestId("launcher-app-test-app-1"))

        const label = screen.getByTestId("stage-app-label-test-app-1")
        expect(label.textContent).toBe(longLabel)
        expect(label.className).toContain("truncate")
        const chip = screen.getByTestId("stage-app-test-app-1")
        expect(chip.className).toContain("max-w-")
        expect(chip).toHaveAttribute("title", longLabel)
      } finally {
        catalogLoader.mockRestore()
      }
    })

    it("keeps exactly one App shortcut plus Apps… on a ~390px phone", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const originalWidth = window.innerWidth
      // Narrow BEFORE mount so the responsive path is the one under test.
      window.innerWidth = 390
      try {
        renderAppRoom()
        await screen.findByTestId("stage-apps-launcher")
        for (const id of ["test-app-1", "test-app-2", "test-app-3"]) {
          openLauncher()
          fireEvent.click(screen.getByTestId(`launcher-app-${id}`))
        }

        expect(window.innerWidth).toBe(390)
        // Exactly one App shortcut — the current App — and never the wide
        // strip's three, let alone a recents row.
        expect(inlineChipIds()).toEqual(["test-app-3"])
        expect(inlineChipIds()).toHaveLength(ROOM_APP_INLINE_SHORTCUTS_MOBILE)
        expect(inlineChipIds().length).toBeLessThan(
          ROOM_APP_INLINE_SHORTCUTS_DESKTOP
        )
        expect(screen.queryByTestId("stage-app-test-app-2")).toBeNull()
        expect(screen.queryByTestId("stage-app-test-app-1")).toBeNull()
        // The launcher entry itself always fits: no horizontal archaeology.
        expect(screen.getByTestId("stage-apps-launcher")).toBeInTheDocument()

        // The launcher still exposes the entire catalog on the narrow surface.
        openLauncher()
        for (const app of TEST_ROOM_APP_CATALOG)
          expect(
            screen.getByTestId(`launcher-app-${app.id}`)
          ).toBeInTheDocument()
      } finally {
        window.innerWidth = originalWidth
      }
    })

    it("shows the single most recent App shortcut on a phone when nothing is open", async () => {
      vi.stubEnv("NODE_ENV", "production")
      window.sessionStorage.setItem(
        "free4chat:room-app-recents:v1:test-room",
        JSON.stringify(["test-app-4", "test-app-2"])
      )
      const originalWidth = window.innerWidth
      window.innerWidth = 390
      try {
        renderAppRoom()
        await screen.findByTestId("stage-apps-launcher")
        // No current App, so the single slot is the most recent App — not two.
        expect(inlineChipIds()).toEqual(["test-app-4"])
        expect(screen.getByTestId("stage-apps-launcher")).toBeInTheDocument()
      } finally {
        window.innerWidth = originalWidth
      }
    })

    it("keeps the current App truthful across a catalog refresh", async () => {
      vi.stubEnv("NODE_ENV", "production")
      vi.useFakeTimers()
      const catalogLoader = vi
        .spyOn(roomAppModule, "loadProductionRoomAppCatalog")
        .mockResolvedValueOnce(TEST_ROOM_APP_CATALOG)
        .mockResolvedValue(
          catalogRevision({ relabel: { "test-app-3": "Renamed 3" } })
        )
      let view: ReturnType<typeof render> | undefined
      try {
        view = renderAppRoom()
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        openLauncher()
        fireEvent.click(screen.getByTestId("launcher-app-test-app-3"))
        expect(screen.getByTestId("stage-app-test-app-3")).toHaveAttribute(
          "aria-pressed",
          "true"
        )

        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            ROOM_APP_CATALOG_REFRESH_INTERVAL_MS
          )
        })

        expect(catalogLoader).toHaveBeenCalledTimes(2)
        openLauncher()
        const current = screen.getByTestId("launcher-app-test-app-3")
        expect(current).toHaveAttribute("aria-current", "true")
        expect(current.textContent).toContain("Renamed 3")
      } finally {
        view?.unmount()
        vi.useRealTimers()
      }
    })
  })
})
