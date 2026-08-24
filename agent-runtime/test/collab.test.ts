import assert from "node:assert/strict"
import { test } from "node:test"

import { buildHarnessTurn, ResidentRoomRuntime } from "../src/core/runtime.js"
import { renderUntrustedRoomTurn } from "../src/adapters/types.js"
import { Free4ChatClientError } from "../src/free4chat/client.js"
import type {
  Free4ChatClient,
  HarnessAdapter,
  HarnessTurnInput,
  JoinResult,
  RoomEvent,
  WaitResult,
} from "../src/types.js"

function textEvent(sequence: number, addressed = false): RoomEvent {
  return {
    sequence,
    type: "text",
    participant: { id: "human", name: "Human", kind: "human" },
    text: `message-${sequence}`,
    addressed,
    createdAt: sequence,
  }
}

function collabRequestEvent(sequence: number): RoomEvent {
  return {
    sequence,
    type: "action",
    participant: { id: "agent-a", name: "Agent A", kind: "agent" },
    actionType: "collab",
    collab: {
      requestId: "req-ui-check-1",
      kind: "request",
      fromParticipantId: "agent-a",
      targetParticipantId: "agent-b",
      summary: "Validate the deployed page in your browser",
      details: { url: "https://www.free4.chat" },
    },
    addressed: true,
    createdAt: sequence,
  }
}

function fakeAdapter(turns: HarnessTurnInput[]): HarnessAdapter {
  return {
    name: "pi",
    async ensureSession() {},
    async runTurn(input) {
      turns.push(input)
      return { text: `turn-reply-${turns.length}` }
    },
    async close() {},
  }
}

function baseClient(overrides: Partial<Free4ChatClient> = {}): Free4ChatClient {
  return {
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
    async joinRoom(): Promise<JoinResult> {
      return {
        participantId: "agent-b",
        participantHandle: "secret-handle",
        cursor: 0,
        expiresAt: Date.now() + 90_000,
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
      return { requestId: "req-1", sequence: 2 }
    },
    async sendCollabResponse() {
      return { sequence: 3 }
    },
    async sendCollabResult() {
      return { sequence: 4 }
    },
    async uploadAttachment() {},
    async leaveRoom() {},
    async close() {},
    ...overrides,
  }
}

async function settle(predicate: () => boolean, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
}

test("buildHarnessTurn projects collab envelopes and compact roster context", () => {
  const input = buildHarnessTurn([collabRequestEvent(7)], undefined, {
    self: {
      instanceId: "instance-9",
      participantId: "agent-b",
      name: "Agent B",
      capabilities: ["browser.control", "browser.authenticated"],
    },
    participants: [
      { id: "human-1", name: "Human", kind: "human" },
      {
        id: "agent-b",
        name: "Agent B",
        kind: "agent",
        advertised: ["browser.control"],
      },
    ],
  })
  assert.equal(input.room.ephemeral, true)
  assert.equal(input.room.self?.instanceId, "instance-9")
  assert.equal(input.room.participants?.length, 2)
  const collab = input.events[0].collab
  assert.equal(collab?.requestId, "req-ui-check-1")
  assert.equal(collab?.kind, "request")
  assert.equal(collab?.fromName, "Agent A")
  assert.equal(collab?.summary, "Validate the deployed page in your browser")
  assert.equal("participantHandle" in input, false)
})

test("plain turns keep working without roster or collab context", () => {
  const input = buildHarnessTurn([textEvent(1)])
  assert.equal(input.room.participants, undefined)
  assert.equal(input.events[0].collab, undefined)
})

test("a targeted collaboration request wakes the resident harness with structured context and no human message", async () => {
  const turns: HarnessTurnInput[] = []
  const sentTexts: string[] = []
  let waits = 0
  const client = baseClient({
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        return {
          events: [collabRequestEvent(cursor + 1)],
          cursor: cursor + 1,
          expiresAt: Date.now() + 90_000,
          participants: [
            {
              id: "agent-a",
              name: "Agent A",
              kind: "agent",
              advertised: ["code.edit", "github"],
            },
            { id: "human-1", name: "Human", kind: "human" },
          ],
        }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText(_handle, text) {
      sentTexts.push(text)
      return { sequence: 99 }
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-b",
    roomId: "room-x",
    name: "Agent B",
    client,
    adapter: fakeAdapter(turns),
  })
  await runtime.start()
  await settle(() => turns.length > 0)
  await runtime.stop()

  assert.equal(turns.length, 1)
  assert.equal(
    turns[0].events.some((event) => event.text),
    false
  )
  const request = turns[0].events.find((event) => event.collab)?.collab
  assert.equal(request?.kind, "request")
  assert.equal(request?.requestId, "req-ui-check-1")
  assert.equal(request?.fromName, "Agent A")
  assert.equal(
    turns[0].room.participants?.some(
      (participant) => participant.advertised?.includes("github") === true
    ),
    true
  )
  assert.equal(turns[0].room.self?.name, "Agent B")
  assert.deepEqual(sentTexts, ["turn-reply-1"])
})

test("ordinary unaddressed text wakes nothing; addressed text still works", async () => {
  const turns: HarnessTurnInput[] = []
  let waits = 0
  const client = baseClient({
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        return {
          events: [
            { ...textEvent(cursor + 1), addressed: false },
            { ...textEvent(cursor + 2), addressed: true },
          ],
          cursor: cursor + 2,
          expiresAt: Date.now() + 90_000,
        }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-b",
    roomId: "room-x",
    name: "Agent B",
    client,
    adapter: fakeAdapter(turns),
  })
  await runtime.start()
  await settle(() => turns.length > 0)
  await runtime.stop()
  assert.equal(turns.length, 1)
  assert.equal(turns[0].events.filter((event) => event.addressed).length, 1)
})

test("advertised capabilities are sent at join, updated in place, and re-advertised after a lease-expiry rejoin", async () => {
  const turns: HarnessTurnInput[] = []
  const joinCalls: Array<string[] | undefined> = []
  const updates: string[][] = []
  let waits = 0
  let joins = 0
  const client = baseClient({
    async joinRoom(_roomId, _name, capabilities): Promise<JoinResult> {
      joins += 1
      joinCalls.push(capabilities)
      return {
        participantId: "agent-b",
        participantHandle: `secret-${joins}`,
        cursor: 100 * joins,
        expiresAt: Date.now() + 90_000,
      }
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 3 || waits === 6)
        throw new Free4ChatClientError(
          "invalid participant handle",
          "invalid_participant_handle"
        )
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async updateCapabilities(_handle, capabilities) {
      updates.push(capabilities)
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-b",
    roomId: "room-x",
    name: "Agent B",
    client,
    adapter: fakeAdapter(turns),
    capabilities: ["browser.control", "browser.authenticated"],
  })
  await runtime.start()
  await settle(() => joins === 2)
  assert.deepEqual(joinCalls[0], ["browser.control", "browser.authenticated"])
  assert.deepEqual(
    joinCalls[1],
    ["browser.control", "browser.authenticated"],
    "rejoin must re-advertise the same list"
  )

  await runtime.updateCapabilities(["shell", "filesystem.local"])
  assert.deepEqual(updates, [["shell", "filesystem.local"]])
  assert.deepEqual(runtime.currentCapabilities(), ["shell", "filesystem.local"])

  await settle(() => joins === 3)
  await runtime.stop()
  assert.deepEqual(
    joinCalls[2],
    ["shell", "filesystem.local"],
    "rejoin after an in-lifetime update must advertise the new list"
  )
})

test("collab passthrough methods forward to the client with the live handle", async () => {
  const requests: unknown[] = []
  const responses: unknown[] = []
  const results: unknown[] = []
  const uploads: unknown[] = []
  const client = baseClient({
    async sendCollabRequest(handle, args) {
      requests.push([handle, args])
      return { requestId: "req-x", sequence: 11 }
    },
    async sendCollabResponse(handle, requestId, decision, summary) {
      responses.push([handle, requestId, decision, summary])
      return { sequence: 12 }
    },
    async sendCollabResult(handle, args) {
      results.push([handle, args])
      return { sequence: 13 }
    },
    async uploadAttachment(handle, file) {
      uploads.push([handle, file])
      return {
        id: "att-9",
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: 4,
        sequence: 14,
      }
    },
  })
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-b",
    roomId: "room-x",
    name: "Agent B",
    client,
    adapter: fakeAdapter([]),
  })
  await runtime.start()
  await runtime.collabRequest({
    targetParticipantId: "agent-a",
    summary: "do a thing",
  })
  await runtime.collabResponse("req-x", "accepted", "on it")
  await runtime.collabResult({
    requestId: "req-x",
    status: "completed",
    summary: "done",
  })
  await runtime.uploadAttachment({
    fileName: "shot.png",
    mimeType: "image/png",
    dataBase64: "AAAA",
  })
  await runtime.stop()
  assert.equal(requests.length, 1)
  assert.equal(responses.length, 1)
  assert.equal(results.length, 1)
  assert.equal(uploads.length, 1)
  assert.match(String(requests[0][0]), /^secret-/)
})

test("rendered prompt exposes roster/capabilities and structured collab without leaking handles", () => {
  const rendered = renderUntrustedRoomTurn(
    buildHarnessTurn([collabRequestEvent(7)], undefined, {
      self: {
        instanceId: "instance-b",
        participantId: "agent-b",
        name: "Agent B",
        capabilities: ["browser.control"],
      },
      participants: [
        {
          id: "agent-a",
          name: "Agent A",
          kind: "agent",
          advertised: ["code.edit", "github"],
        },
        { id: "human-1", name: "Human", kind: "human" },
      ],
    })
  )
  assert.match(rendered, /Participants and advertised capabilities/)
  assert.match(rendered, /Agent A \(agent\) — advertised: code\.edit, github/)
  assert.match(rendered, /Human \(human\)/)
  assert.match(
    rendered,
    /\[collaboration request id=req-ui-check-1 from Agent A\]/
  )
  assert.match(rendered, /Validate the deployed page in your browser/)
  assert.match(rendered, /details: url=https:\/\/www\.free4\.chat/)
  assert.match(rendered, /never authorization/)
  assert.doesNotMatch(rendered, /participantHandle/i)

  const plain = renderUntrustedRoomTurn(buildHarnessTurn([textEvent(1)]))
  assert.equal(/collaboration/.test(plain), false)
  assert.match(plain, /do not ask for or invent room identity/i)
})
