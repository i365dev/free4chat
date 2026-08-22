import { test } from "node:test"
import assert from "node:assert/strict"

import {
  decodeToolResult,
  Free4ChatClientError,
} from "../src/free4chat/client.js"
import { boundedPush, EventBuffer } from "../src/core/eventBuffer.js"
import {
  buildHarnessTurn,
  retryDelay,
  ResidentRoomRuntime,
} from "../src/core/runtime.js"
import type {
  Free4ChatClient,
  HarnessAdapter,
  JoinResult,
  RoomEvent,
  WaitResult,
} from "../src/types.js"

function event(sequence: number, addressed = false): RoomEvent {
  return {
    sequence,
    type: "text",
    participant: { id: "human", name: "Human", kind: "human" },
    text: `message-${sequence}`,
    addressed,
    createdAt: sequence,
  }
}

test("MCP isError is failure even when the HTTP request succeeded", () => {
  assert.throws(
    () =>
      decodeToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "invalid_participant_handle" }),
          },
        ],
      } as never),
    (error: unknown) =>
      error instanceof Free4ChatClientError &&
      error.code === "invalid_participant_handle"
  )
})

test("room context is bounded and never contains the participant capability", () => {
  const buffer = new EventBuffer(2, 10_000)
  buffer.add(event(1))
  buffer.add(event(2))
  buffer.add(event(3))
  assert.deepEqual(
    buffer.snapshot().map((item) => item.sequence),
    [2, 3]
  )

  const input = buildHarnessTurn([event(3, true)])
  assert.equal("participantHandle" in input, false)
  assert.equal("participantHandle" in input.events[0], false)
})

test("cursor timeout continues and addressed turns are delivered once", async () => {
  assert.equal(retryDelay(0), 1000)
  assert.equal(retryDelay(20), 10_000)

  const sent: string[] = []
  let waits = 0
  let joins = 0
  const client: Free4ChatClient = {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo() {
      return { exists: true, meetingNotes: { active: false } }
    },
    async joinRoom(): Promise<JoinResult> {
      joins += 1
      return {
        participantId: `agent-${joins}`,
        participantHandle: `secret-${joins}`,
        cursor: 0,
        expiresAt: Date.now() + 90_000,
      }
    },
    async waitForEvents(_handle: string, cursor: number): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        return {
          events: [event(cursor + 1, true)],
          cursor: cursor + 1,
          expiresAt: Date.now() + 90_000,
        }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText(_handle, text) {
      sent.push(text)
      return { sequence: 2 }
    },
    async readAttachment() {
      throw new Error("not used")
    },
    async leaveRoom() {},
    async close() {},
  }
  const adapter: HarnessAdapter = {
    name: "pi",
    async ensureSession() {},
    async runTurn(input) {
      assert.equal(input.events[0].text, "message-1")
      return { text: "reply" }
    },
    async close() {},
  }
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-1",
    roomId: "test",
    name: "Agent",
    client,
    adapter,
  })
  await runtime.start()
  for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  await runtime.stop()
  assert.deepEqual(sent, ["reply"])
  assert.ok(waits > 1)
})

test("a timed-out Harness turn releases turn state without replaying the event", async () => {
  let waits = 0
  let turns = 0
  const client: Free4ChatClient = {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo() {
      return { exists: true, meetingNotes: { active: false } }
    },
    async joinRoom(): Promise<JoinResult> {
      return {
        participantId: "agent",
        participantHandle: "secret",
        cursor: 0,
        expiresAt: Date.now() + 90_000,
      }
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        return {
          events: [event(1, true)],
          cursor: 1,
          expiresAt: Date.now() + 90_000,
        }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText() {
      throw new Error("timed-out turns must not send a reply")
    },
    async readAttachment() {
      throw new Error("not used")
    },
    async leaveRoom() {},
    async close() {},
  }
  const adapter: HarnessAdapter = {
    name: "hermes",
    async ensureSession() {},
    async runTurn() {
      turns += 1
      throw new Error("ACP turn timed out")
    },
    async close() {},
  }
  const runtime = new ResidentRoomRuntime({
    instanceId: "timeout-instance",
    roomId: "test",
    name: "Hermes",
    client,
    adapter,
  })
  await runtime.start()
  for (
    let attempt = 0;
    attempt < 40 && (turns === 0 || runtime.getStatus().state === "turn");
    attempt += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(turns, 1)
  assert.equal(runtime.getStatus().state, "waiting")
  await runtime.stop()
})

test("pending addressed events are bounded", () => {
  const values: number[] = []
  for (let index = 0; index < 10; index += 1) boundedPush(values, index, 8)
  assert.deepEqual(values, [2, 3, 4, 5, 6, 7, 8, 9])
})

test("an expired capability rejoins from a fresh cursor without replay", async () => {
  let joins = 0
  let waits = 0
  const client: Free4ChatClient = {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo() {
      return { exists: true, meetingNotes: { active: false } }
    },
    async joinRoom(): Promise<JoinResult> {
      joins += 1
      return {
        participantId: `agent-${joins}`,
        participantHandle: `secret-${joins}`,
        cursor: joins === 1 ? 0 : 10,
        expiresAt: Date.now() + 90_000,
      }
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        throw new Free4ChatClientError(
          "invalid participant",
          "invalid_participant_handle"
        )
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText() {
      return { sequence: 1 }
    },
    async readAttachment() {
      throw new Error("not used")
    },
    async leaveRoom() {},
    async close() {},
  }
  const adapter: HarnessAdapter = {
    name: "claude",
    async ensureSession() {},
    async runTurn() {
      throw new Error("historical events must not replay")
    },
    async close() {},
  }
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-2",
    roomId: "test",
    name: "Agent",
    client,
    adapter,
  })
  await runtime.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await runtime.stop()
  assert.equal(joins, 2)
})

test("an addressed event resolves its image in the runtime before the Harness turn", async () => {
  let waits = 0
  let sawImage = false
  const client: Free4ChatClient = {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo() {
      return { exists: true, meetingNotes: { active: false } }
    },
    async joinRoom(): Promise<JoinResult> {
      return {
        participantId: "agent",
        participantHandle: "secret",
        cursor: 0,
        expiresAt: Date.now() + 90_000,
      }
    },
    async waitForEvents(_handle, cursor): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        return {
          events: [
            {
              ...event(1),
              type: "image",
              attachment: {
                id: "attachment",
                fileName: "image.png",
                mimeType: "image/png",
                size: 10,
              },
            },
            event(2, true),
          ],
          cursor: 2,
          expiresAt: Date.now() + 90_000,
        }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText() {
      return { sequence: 3 }
    },
    async readAttachment() {
      return { data: "base64", mimeType: "image/png" }
    },
    async leaveRoom() {},
    async close() {},
  }
  const adapter: HarnessAdapter = {
    name: "pi",
    async ensureSession() {},
    async runTurn(input) {
      sawImage = Boolean(input.events[0].image)
      return {}
    },
    async close() {},
  }
  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-3",
    roomId: "test",
    name: "Agent",
    client,
    adapter,
  })
  await runtime.start()
  for (let attempt = 0; attempt < 20 && !sawImage; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  await runtime.stop()
  assert.equal(sawImage, true)
})
