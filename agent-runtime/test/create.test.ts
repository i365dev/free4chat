import assert from "node:assert/strict"
import { test } from "node:test"

import { ResidentRoomRuntime } from "../src/core/runtime.js"
import { ModernMcpFree4ChatClient } from "../src/free4chat/modernClient.js"
import { Free4ChatClientError } from "../src/free4chat/client.js"
import type { MeetingNotesController } from "../src/media/meetingNotesController.js"
import type {
  CreateRoomResult,
  Free4ChatClient,
  HarnessAdapter,
  HarnessTurnInput,
  JoinResult,
  WaitResult,
} from "../src/types.js"

const VALID_CREATE_PAYLOAD = {
  participant: { id: "creator-1" },
  participantHandle: "secret-create-handle",
  cursor: 0,
  expiresAt: 123456,
  invite: {
    kind: "free4chat.room-invite",
    version: 1,
    roomId: "room-new",
    roomUrl: "https://www.free4.chat/room?id=room-new",
  },
}

function fakeAdapter(turns: HarnessTurnInput[]): HarnessAdapter {
  return {
    name: "pi",
    async ensureSession() {},
    async runTurn(input) {
      turns.push(input)
      return { text: `reply-${turns.length}` }
    },
    async close() {},
  }
}

function baseClient(overrides: Partial<Free4ChatClient> = {}): Free4ChatClient {
  const client: Free4ChatClient = {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo() {
      return {
        exists: true,
        meetingNotesMediaAvailable: false,
        meetingNotes: { active: false },
      }
    },
    async joinRoom(roomId, name, capabilities): Promise<JoinResult> {
      void roomId
      void name
      void capabilities
      return {
        participantId: "creator-1",
        participantHandle: "rejoined-handle",
        cursor: 500,
        expiresAt: Date.now() + 90_000,
      }
    },
    async createRoom(name, capabilities): Promise<CreateRoomResult> {
      void name
      void capabilities
      return {
        participantId: "creator-1",
        participantHandle: "secret-create-handle",
        cursor: 0,
        expiresAt: 123456,
        invite: { ...VALID_CREATE_PAYLOAD.invite },
      }
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText() {
      return { sequence: 1 }
    },
    async readAttachment() {
      throw new Error("not used")
    },
    async updateCapabilities() {},
    async sendCollabRequest() {
      return { requestId: "req", sequence: 2 }
    },
    async sendCollabResponse() {
      return { sequence: 3 }
    },
    async sendCollabResult() {
      return { sequence: 4 }
    },
    async uploadAttachment() {
      return {
        id: "att",
        fileName: "f.png",
        mimeType: "image/png",
        size: 4,
        sequence: 5,
      }
    },
    async leaveRoom() {},
    async close() {},
    ...overrides,
  }
  return client
}

async function settle(predicate: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
}

test("startByCreate adopts the create result without ever calling joinRoom; wait loop starts at the create cursor", async () => {
  const turns: HarnessTurnInput[] = []
  let waits = 0
  let firstWaitCursor = -1
  let joinCalls = 0
  let createCalls = 0
  const client = baseClient({
    async joinRoom(): Promise<JoinResult> {
      joinCalls += 1
      throw new Error("joinRoom must not be called during create lifecycle")
    },
    async createRoom(): Promise<CreateRoomResult> {
      createCalls += 1
      return JSON.parse(
        JSON.stringify(VALID_CREATE_PAYLOAD)
      ) as CreateRoomResult
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 1) firstWaitCursor = cursor
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "inst-create",
    name: "Agent C",
    client,
    adapter: fakeAdapter(turns),
    capabilities: ["shell"],
  })
  try {
    const created = await runtime.startByCreate()
    assert.equal(created.invite.roomId, "room-new")
    assert.equal(created.invite.kind, "free4chat.room-invite")
    assert.equal(created.invite.version, 1)
    assert.equal(joinCalls, 0)
    assert.equal(createCalls, 1)
    assert.equal(runtime.getStatus().roomId, "room-new")
    await settle(() => waits >= 1)
    assert.equal(firstWaitCursor, 0)
    // The public invite is returned; the private handle stays in the runtime.
    assert.equal(JSON.stringify(created.invite).includes("secret"), false)
  } finally {
    await runtime.stop()
  }
})

test("lease-expiry reconnect after creation uses normal joinRoom with the same capabilities — never re-creating", async () => {
  const turns: HarnessTurnInput[] = []
  const joinCapabilityCalls: Array<string[] | undefined> = []
  let joins = 0
  let creates = 0
  let waits = 0
  let lastWaitCursor = -1
  const client = baseClient({
    async joinRoom(_roomId, _name, capabilities): Promise<JoinResult> {
      joins += 1
      joinCapabilityCalls.push(capabilities)
      return {
        participantId: "creator-1",
        participantHandle: "rejoined-handle",
        cursor: 900,
        expiresAt: Date.now() + 90_000,
      }
    },
    async createRoom(): Promise<CreateRoomResult> {
      creates += 1
      return JSON.parse(
        JSON.stringify(VALID_CREATE_PAYLOAD)
      ) as CreateRoomResult
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      lastWaitCursor = cursor
      if (waits === 3)
        throw new Free4ChatClientError(
          "invalid participant handle",
          "invalid_participant_handle"
        )
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "inst-create",
    name: "Agent C",
    client,
    adapter: fakeAdapter(turns),
    capabilities: ["shell"],
  })
  try {
    await runtime.startByCreate()
    await settle(() => joins === 1)
    assert.equal(creates, 1, "create must happen exactly once")
    assert.deepEqual(joinCapabilityCalls[0], ["shell"])
    // The rejoin adopted the fresh join cursor (900) for subsequent polls.
    await settle(() => lastWaitCursor === 900 && waits >= 4)
    assert.equal(lastWaitCursor, 900)
  } finally {
    await runtime.stop()
  }
})

test("modern client createRoom forwards name/capabilities and validates the invite shape", async () => {
  const originalFetch = globalThis.fetch
  let serve: unknown = VALID_CREATE_PAYLOAD
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    if (body.params?.name !== "create_room")
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{}" }] },
      })
    calls += 1
    if (calls === 1)
      assert.deepEqual(body.params.arguments, {
        name: "Agent C",
        capabilities: ["code.edit"],
      })
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(serve) }] },
    })
  }
  const brokenPayloads: unknown[] = [
    {
      ...VALID_CREATE_PAYLOAD,
      invite: { ...VALID_CREATE_PAYLOAD.invite, kind: "other.kind" },
    },
    {
      ...VALID_CREATE_PAYLOAD,
      invite: { ...VALID_CREATE_PAYLOAD.invite, version: 2 },
    },
    {
      ...VALID_CREATE_PAYLOAD,
      invite: {
        ...VALID_CREATE_PAYLOAD.invite,
        roomUrl: "https://evil.example/room?id=x",
      },
    },
    {
      ...VALID_CREATE_PAYLOAD,
      invite: { ...VALID_CREATE_PAYLOAD.invite, roomId: "" },
    },
    { ...VALID_CREATE_PAYLOAD, invite: undefined },
    { ...VALID_CREATE_PAYLOAD, participantHandle: 42 },
    { ...VALID_CREATE_PAYLOAD, participant: {} },
  ]
  try {
    const client = new ModernMcpFree4ChatClient("https://example.test/mcp")
    const result = await client.createRoom("Agent C", ["code.edit"])
    assert.deepEqual(result.invite, {
      kind: "free4chat.room-invite",
      version: 1,
      roomId: "room-new",
      roomUrl: "https://www.free4.chat/room?id=room-new",
    })
    assert.equal(result.participantId, "creator-1")
    for (const broken of brokenPayloads) {
      serve = broken
      await assert.rejects(
        () => client.createRoom("Agent C"),
        (error: unknown) =>
          error instanceof Free4ChatClientError && error.code === "tool_error"
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("legacy client implements createRoom over the same envelope", async () => {
  const legacy = new (
    await import("../src/free4chat/client.js")
  ).McpFree4ChatClient("https://example.test/mcp")
  ;(legacy as unknown as Record<string, unknown>).client = {
    async callTool({
      arguments: args,
    }: {
      arguments?: Record<string, unknown>
    }) {
      assert.equal(args?.name, "Agent C")
      assert.deepEqual(args?.capabilities, ["shell"])
      return {
        content: [{ type: "text", text: JSON.stringify(VALID_CREATE_PAYLOAD) }],
      }
    },
  }
  const created = await legacy.createRoom("Agent C", ["shell"])
  assert.equal(created.invite.roomId, "room-new")
})

test("create adoption initializes Meeting Notes for the created participant; rejoin rebuilds it without re-creating", async () => {
  const turns: HarnessTurnInput[] = []
  const controllers: Array<{ started: number; stopped: number }> = []
  let joins = 0
  let creates = 0
  let waits = 0
  const waitCursors: number[] = []
  // A structurally valid handle (base64url JSON, mirroring MCP encodeHandle)
  // so restartMeetingNotesController can decode the created participant.
  const handle = Buffer.from(
    JSON.stringify({
      room: "room-new",
      participantId: "creator-1",
      participantToken: "tok",
    })
  )
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
  const client = baseClient({
    async joinRoom(): Promise<JoinResult> {
      joins += 1
      return {
        participantId: "creator-1",
        participantHandle: handle,
        cursor: 900,
        expiresAt: Date.now() + 90_000,
      }
    },
    async createRoom(): Promise<CreateRoomResult> {
      creates += 1
      return {
        participantId: "creator-1",
        participantHandle: handle,
        cursor: 0,
        expiresAt: 123456,
        invite: { ...VALID_CREATE_PAYLOAD.invite },
      }
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      waitCursors.push(cursor)
      if (waits === 3)
        throw new Free4ChatClientError(
          "invalid participant handle",
          "invalid_participant_handle"
        )
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "inst-create-mn",
    name: "Agent C",
    client,
    adapter: fakeAdapter(turns),
    capabilities: ["shell"],
    createMeetingNotesController: () => {
      const spy = { started: 0, stopped: 0 }
      controllers.push(spy)
      return {
        start: async () => {
          spy.started += 1
        },
        stop: async () => {
          spy.stopped += 1
        },
      } as unknown as MeetingNotesController
    },
  })
  try {
    const created = await runtime.startByCreate()
    assert.equal(creates, 1)
    assert.equal(joins, 0)
    assert.equal(runtime.getStatus().roomId, created.invite.roomId)
    await settle(() => controllers[0]?.started === 1)

    // Lease-expiry style rejoin: normal joinRoom exactly once, old controller
    // stopped, new controller initialized and started; still only one create.
    await settle(() => joins === 1 && (controllers[1]?.started ?? 0) === 1)
    assert.equal(creates, 1, "rejoin must never re-create the room")
    assert.ok(controllers[0].stopped >= 1, "old controller must be stopped")
    assert.equal(controllers.length, 2)
    // Post-rejoin polling resumes from the joined cursor.
    await settle(() => waitCursors[waitCursors.length - 1] === 900)
  } finally {
    await runtime.stop()
  }
})
