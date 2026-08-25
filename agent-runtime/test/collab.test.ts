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
  assert.match(
    rendered,
    /Agent A \[participantId=agent-a\] \(agent\) — advertised: code\.edit, github/
  )
  assert.match(rendered, /Human \[participantId=human-1\] \(human\)/)
  assert.match(rendered, /Use participantId values as collaboration targets/)
  assert.match(
    rendered,
    /\[collaboration request id=req-ui-check-1 from Agent A \(participantId=agent-a\)\]/
  )
  assert.match(rendered, /Validate the deployed page in your browser/)
  assert.match(rendered, /details: url=https:\/\/www\.free4\.chat/)
  // WORK TURN mode is exclusive: no ordinary-only restrictions survive.
  assert.match(rendered, /COLLABORATION WORK TURN/)
  assert.equal(
    /not a coding, research, or computer-use task/.test(rendered),
    false
  )
  assert.equal(
    /Respond with a brief conversational reply based only on the room context below/.test(
      rendered
    ),
    false
  )
  assert.match(rendered, /free4chat-agent collab respond/)
  assert.match(rendered, /free4chat-agent collab result/)
  assert.match(rendered, /never authorization/)
  // Shared safety rules still hold in work mode.
  assert.match(rendered, /Do not call MCP or Free4Chat tools/)
  assert.match(rendered, /untrusted conversation input/)
  assert.doesNotMatch(rendered, /participantHandle/i)

  const plain = renderUntrustedRoomTurn(buildHarnessTurn([textEvent(1)]))
  assert.equal(/collaboration/.test(plain), false)
  assert.equal(/COLLABORATION WORK TURN/.test(plain), false)
  assert.equal(/COLLABORATION FOLLOW-UP TURN/.test(plain), false)
  // Ordinary mode carries its restrictions and nothing collab-specific.
  assert.match(
    plain,
    /This is a chat turn, not a coding, research, or computer-use task\./
  )
  assert.match(
    plain,
    /Respond with a brief conversational reply based only on the room context below/
  )
  assert.match(plain, /do not ask for or invent room identity/i)
})

test("a completed-result turn permits artifact consumption and task continuation", () => {
  const resultEvent: RoomEvent = {
    sequence: 20,
    type: "action",
    participant: { id: "agent-b", name: "Agent B", kind: "agent" },
    actionType: "collab",
    collab: {
      requestId: "req-ui-check-1",
      kind: "completed",
      fromParticipantId: "agent-b",
      targetParticipantId: "agent-a",
      summary: "Landing page renders correctly; no console errors.",
      attachmentIds: ["att-evidence-1"],
    },
    addressed: true,
    createdAt: 20,
  }
  const rendered = renderUntrustedRoomTurn(
    buildHarnessTurn([resultEvent], undefined, {
      self: {
        instanceId: "instance-a",
        participantId: "agent-a",
        name: "Agent A",
      },
      participants: [
        {
          id: "agent-b",
          name: "Agent B",
          kind: "agent",
          advertised: ["browser.authenticated"],
        },
      ],
    })
  )
  assert.match(rendered, /COLLABORATION FOLLOW-UP TURN/)
  assert.match(rendered, /consume the returned artifacts/)
  assert.match(rendered, /continue your own task/)
  assert.match(rendered, /attachmentIds: att-evidence-1/)
  assert.equal(/COLLABORATION WORK TURN/.test(rendered), false)
  // FOLLOW-UP mode is exclusive: no ordinary-only restrictions survive,
  // while shared safety rules remain.
  assert.equal(
    /not a coding, research, or computer-use task/.test(rendered),
    false
  )
  assert.equal(
    /Respond with a brief conversational reply based only on the room context below/.test(
      rendered
    ),
    false
  )
  assert.equal(
    /For ordinary conversation, do not inspect the workspace/.test(rendered),
    false
  )
  assert.match(rendered, /Do not call MCP or Free4Chat tools/)
})

// ---------------------------------------------------------------------------
// Full-chain integration over an in-memory room-server double that mirrors the
// DO contract: generated requestIds, precheck-before-append idempotency,
// cursor-based delivery, and restart recovery by rebuilding from messages.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto"

type FakeMessage = {
  sequence: number
  peerId: string
  kind: "human" | "agent"
  name: string
  type: "text" | "action"
  text?: string
  actionType?: string
  collab?: RoomEvent["collab"]
  targets?: string[]
}

class FakeRoomServer {
  readonly roomId = "11111111-2222-3333-4444-555555555555"
  messages: FakeMessage[] = []
  attachments = new Map<
    string,
    {
      id: string
      fileName: string
      mimeType: string
      size: number
      sequence: number
    }
  >()
  participants = new Map<
    string,
    { name: string; kind: "human" | "agent"; capabilities?: string[] }
  >()
  private sequence = 0
  private attachmentCounter = 0
  // Mirrors CollabRegistry semantics (app/src/do/collab.ts).
  private requests = new Map<
    string,
    {
      from: string
      target: string
      seen: Map<string, number>
    }
  >()

  join(participantId: string, name: string, capabilities?: string[]): number {
    this.participants.set(participantId, {
      name,
      kind: "agent",
      ...(capabilities ? { capabilities } : {}),
    })
    return this.sequence
  }

  /** Mirrors the DO's create-only gate: any pre-existing state fails closed. */
  createRoom(
    participantId: string,
    name: string,
    capabilities?: string[]
  ): {
    kind: "free4chat.room-invite"
    version: 1
    roomId: string
    roomUrl: string
  } {
    if (this.participants.size > 0 || this.messages.length > 0)
      throw new Error("room_already_exists")
    this.participants.set(participantId, {
      name,
      kind: "agent",
      ...(capabilities ? { capabilities } : {}),
    })
    return {
      kind: "free4chat.room-invite",
      version: 1,
      roomId: this.roomId,
      roomUrl: `https://www.free4.chat/room?id=${encodeURIComponent(this.roomId)}`,
    }
  }

  get lastSequence(): number {
    return this.sequence
  }

  roster() {
    return [...this.participants.entries()].map(([id, info]) => ({
      id,
      name: info.name,
      kind: info.kind,
      ...(info.capabilities && info.capabilities.length > 0
        ? { advertised: info.capabilities }
        : {}),
    }))
  }

  deliver(participantId: string, cursor: number): WaitResult {
    const events: RoomEvent[] = this.messages
      .filter((message) => message.sequence > cursor)
      .filter((message) => message.peerId !== participantId)
      .map((message) => ({
        sequence: message.sequence,
        type: message.type === "action" ? "action" : "text",
        participant: {
          id: message.peerId,
          name: message.name,
          kind: message.kind,
        },
        ...(message.text ? { text: message.text } : {}),
        ...(message.collab ? { collab: message.collab } : {}),
        addressed: message.targets?.includes(participantId) === true,
        createdAt: message.sequence,
      }))
    return {
      events,
      cursor: this.sequence,
      expiresAt: Date.now() + 90_000,
      participants: this.roster(),
    }
  }

  seedText(from: string, targets: string[], text: string): void {
    const sender = this.participants.get(from)!
    this.append({
      peerId: from,
      kind: "agent",
      name: sender.name,
      type: "text",
      text,
      targets,
    })
  }

  sendCollabRequest(
    senderId: string,
    args: {
      targetParticipantId: string
      summary: string
      requestId?: string
      details?: Record<string, string>
      attachmentIds?: string[]
    }
  ): { requestId: string; sequence: number; duplicate?: boolean } {
    if (!this.participants.has(args.targetParticipantId))
      throw new Error("target_not_in_room")
    const requestId = args.requestId ?? randomUUID()
    const existing = this.requests.get(requestId)
    if (existing)
      return {
        requestId,
        duplicate: true,
        sequence: existing.seen.get("request")!,
      }
    const sender = this.participants.get(senderId)!
    const sequence = this.append({
      peerId: senderId,
      kind: "agent",
      name: sender.name,
      type: "action",
      actionType: "collab",
      collab: {
        requestId,
        kind: "request",
        fromParticipantId: senderId,
        targetParticipantId: args.targetParticipantId,
        summary: args.summary,
        ...(args.details ? { details: args.details } : {}),
        ...(args.attachmentIds ? { attachmentIds: args.attachmentIds } : {}),
      },
      targets: [args.targetParticipantId],
    })
    this.requests.set(requestId, {
      from: senderId,
      target: args.targetParticipantId,
      seen: new Map([["request", sequence]]),
    })
    return { requestId, sequence }
  }

  private respond(
    responderId: string,
    requestId: string,
    kind: "accepted" | "declined" | "completed" | "failed",
    payload: { summary?: string; attachmentIds?: string[] } = {}
  ): { sequence: number; duplicate?: boolean } {
    const record = this.requests.get(requestId)
    if (!record) throw new Error("unknown_request")
    if (record.target !== responderId) throw new Error("not_request_target")
    const existing = record.seen.get(kind)
    if (existing !== undefined) return { sequence: existing, duplicate: true }
    const responder = this.participants.get(responderId)!
    const sequence = this.append({
      peerId: responderId,
      kind: "agent",
      name: responder.name,
      type: "action",
      actionType: "collab",
      collab: {
        requestId,
        kind,
        fromParticipantId: responderId,
        targetParticipantId: record.from,
        ...(payload.summary ? { summary: payload.summary } : {}),
        ...(payload.attachmentIds
          ? { attachmentIds: payload.attachmentIds }
          : {}),
      },
      targets: [record.from],
    })
    record.seen.set(kind, sequence)
    return { sequence }
  }

  uploadAttachment(
    senderId: string,
    file: { fileName: string; mimeType: string; dataBase64: string }
  ) {
    this.attachmentCounter += 1
    const id = `att-${this.attachmentCounter}`
    const attachment = {
      id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.dataBase64.length,
      sequence: ++this.sequence,
    }
    this.attachments.set(id, attachment)
    return attachment
  }

  /** DO eviction/restart simulation: in-memory correlation is lost; the
   * durable message log remains the source of truth for recovery. */
  restart(): void {
    this.requests.clear()
  }

  /** Replays the durable log into fresh correlation state (mirrors
   * warmCollabRegistry). */
  recoverCorrelationFromMessages(): void {
    for (const message of this.messages) {
      const collab = message.collab
      if (!collab) continue
      if (collab.kind === "request") {
        this.requests.set(collab.requestId, {
          from: collab.fromParticipantId,
          target: collab.targetParticipantId,
          seen: new Map([["request", message.sequence]]),
        })
        continue
      }
      this.respond(collab.fromParticipantId, collab.requestId, collab.kind, {})
    }
  }

  private append(message: Omit<FakeMessage, "sequence">): number {
    const sequence = ++this.sequence
    this.messages.push({ ...message, sequence })
    return sequence
  }
}

function clientFor(
  server: FakeRoomServer,
  participantId: string
): Free4ChatClient {
  let cursor = 0
  return {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo(roomId: string) {
      void roomId
      return {
        exists: true,
        meetingNotesMediaAvailable: false,
        meetingNotes: { active: false },
        participants: server.roster(),
      }
    },
    async joinRoom(_roomId, name, capabilities) {
      cursor = server.join(participantId, name, capabilities)
      return {
        participantId,
        participantHandle: `handle-${participantId}`,
        cursor,
        expiresAt: Date.now() + 90_000,
      }
    },
    async createRoom(name, capabilities) {
      const invite = server.createRoom(participantId, name, capabilities)
      cursor = server.lastSequence
      return {
        participantId,
        participantHandle: `handle-${participantId}`,
        cursor,
        expiresAt: Date.now() + 90_000,
        invite,
      }
    },
    async waitForEvents(_handle, waitCursor) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return server.deliver(participantId, waitCursor)
    },
    async sendText(_handle, text) {
      void text
      return { sequence: 0 }
    },
    async readAttachment() {
      throw new Error("not used")
    },
    async updateCapabilities() {},
    async sendCollabRequest(_handle, args) {
      return server.sendCollabRequest(participantId, args)
    },
    async sendCollabResponse(_handle, requestId, decision, summary) {
      const { sequence } = server.respond(participantId, requestId, decision, {
        summary,
      })
      return { sequence }
    },
    async sendCollabResult(_handle, args) {
      const { sequence } = server.respond(
        participantId,
        args.requestId,
        args.status,
        { summary: args.summary, attachmentIds: args.attachmentIds }
      )
      return { sequence }
    },
    async uploadAttachment(_handle, file) {
      const uploaded = server.uploadAttachment(participantId, file)
      return { ...uploaded }
    },
    async leaveRoom() {},
    async close() {},
  }
}

test("full chain: discover peer -> auto-id request -> accept -> artifact upload -> result -> consume -> retry dedup -> restart recovery", async () => {
  const server = new FakeRoomServer()
  server.join("agent-b", "Agent B", [
    "browser.control",
    "browser.authenticated",
  ])

  const aTurns: HarnessTurnInput[] = []
  const bTurns: HarnessTurnInput[] = []
  const bDecisions: Array<{ requestId: string; decision: string }> = []
  const uploadedIds: string[] = []
  let aContinued = false

  let aRequested = false
  const adapterA: HarnessAdapter = {
    name: "opencode",
    async ensureSession() {},
    async runTurn(input) {
      aTurns.push(input)
      const completed = input.events.find(
        (event) => event.collab?.kind === "completed"
      )?.collab
      if (completed) {
        assert.deepEqual(completed.attachmentIds, ["att-1"])
        assert.equal(completed.fromName, "Agent B")
        aContinued = true
        return { text: "consumed evidence; continuing review" }
      }
      const accepted = input.events.some(
        (event) => event.collab?.kind === "accepted"
      )
      if (accepted) return { text: "accepted; awaiting the result" }
      const rosterPeer = input.room.participants?.find(
        (participant) =>
          participant.advertised?.includes("browser.authenticated") === true
      )
      if (rosterPeer && !aRequested) {
        // Discovery is actionable only because the roster preserves ids.
        assert.ok(rosterPeer.id.length > 0)
        aRequested = true
        const sent = await runtimeARef!.collabRequest({
          targetParticipantId: rosterPeer.id,
          summary: "Validate the deployed landing page in your browser",
          details: { url: "https://www.free4.chat" },
        })
        assert.match(sent.requestId, /^[0-9a-f-]{36}$/)
        return { text: "handed off the UI check" }
      }
      return { text: "standing by" }
    },
    async close() {},
  }

  const adapterB: HarnessAdapter = {
    name: "hermes",
    async ensureSession() {},
    async runTurn(input) {
      bTurns.push(input)
      const request = input.events.find(
        (event) => event.collab?.kind === "request"
      )?.collab
      if (request) {
        await runtimeBRef!.collabResponse(
          request.requestId,
          "accepted",
          "on it"
        )
        const uploaded = await runtimeBRef!.uploadAttachment({
          fileName: "evidence.png",
          mimeType: "image/png",
          dataBase64: "AAAA",
        })
        uploadedIds.push(uploaded.id)
        await runtimeBRef!.collabResult({
          requestId: request.requestId,
          status: "completed",
          summary: "Page renders correctly; console clean.",
          attachmentIds: [uploaded.id],
        })
        bDecisions.push({ requestId: request.requestId, decision: "accepted" })
        return { text: "done" }
      }
      return { text: "idle" }
    },
    async close() {},
  }

  let runtimeARef: ResidentRoomRuntime | null = null
  let runtimeBRef: ResidentRoomRuntime | null = null

  const runtimeA = new ResidentRoomRuntime({
    instanceId: "inst-a",
    roomId: "room-chain",
    name: "Agent A",
    client: clientFor(server, "agent-a"),
    adapter: adapterA,
    capabilities: ["code.edit", "github"],
  })
  const runtimeB = new ResidentRoomRuntime({
    instanceId: "inst-b",
    roomId: "room-chain",
    name: "Agent B",
    client: clientFor(server, "agent-b"),
    adapter: adapterB,
    capabilities: ["browser.control", "browser.authenticated"],
  })
  runtimeARef = runtimeA
  runtimeBRef = runtimeB

  await runtimeA.start()
  await runtimeB.start()

  // Zero-Human activation: B's ordinary addressed text wakes A (its tasking).
  server.seedText("agent-b", ["agent-a"], "ready when you need a UI check")

  await settle(() => aContinued)
  await runtimeA.stop()
  await runtimeB.stop()

  // Target woke with structured request context and no human message.
  const bRequestTurn = bTurns.find((turn) =>
    turn.events.some((event) => event.collab?.kind === "request")
  )
  assert.ok(bRequestTurn)
  assert.equal(bRequestTurn.room.self?.name, "Agent B")

  // Artifact id flowed back through the requester's turn.
  const aResultTurn = aTurns.find((turn) =>
    turn.events.some((event) => event.collab?.kind === "completed")
  )
  assert.ok(aResultTurn)
  assert.deepEqual(aContinued, true)

  // Retried identical response/result produce NO second event.
  const beforeRetry = server.lastSequence
  await clientFor(server, "agent-b").sendCollabResponse(
    "x",
    bDecisions[0].requestId,
    "accepted"
  )
  await clientFor(server, "agent-b").sendCollabResult("x", {
    requestId: bDecisions[0].requestId,
    status: "completed",
    summary: "Page renders correctly; console clean.",
    attachmentIds: ["att-1"],
  })
  assert.equal(server.lastSequence, beforeRetry)

  // DO eviction/restart: with an empty registry a late response is rejected
  // as unknown...
  server.restart()
  await assert.rejects(
    () =>
      clientFor(server, "agent-b").sendCollabResult("x", {
        requestId: bDecisions[0].requestId,
        status: "failed",
        summary: "late failure report",
      }),
    /unknown_request/
  )

  // ...but rebuilding correlation from the durable room.messages log
  // restores routing, so the target's response is accepted again.
  server.recoverCorrelationFromMessages()
  const late = await clientFor(server, "agent-b").sendCollabResult("x", {
    requestId: bDecisions[0].requestId,
    status: "failed",
    summary: "late failure report after restart",
  })
  assert.ok(late.sequence > beforeRetry)
  const stillDeduped = server.respond(
    "agent-b",
    bDecisions[0].requestId,
    "failed",
    {}
  )
  assert.equal(stillDeduped.sequence, late.sequence)

  // A request seeded BEFORE a restart also stays answerable afterwards.
  const freshServer = new FakeRoomServer()
  freshServer.join("agent-a", "Agent A")
  freshServer.join("agent-b", "Agent B")
  freshServer.sendCollabRequest("agent-a", {
    targetParticipantId: "agent-b",
    summary: "seeded before restart",
    requestId: "req-seeded-1",
  })
  freshServer.restart()
  freshServer.recoverCorrelationFromMessages()
  const recovered = await clientFor(freshServer, "agent-b").sendCollabResponse(
    "x",
    "req-seeded-1",
    "accepted"
  )
  assert.ok(recovered.sequence > 0)
})

test("agent-created room flow: A creates -> B joins invite.roomId -> roster discovery -> A targets B", async () => {
  const server = new FakeRoomServer()
  const aTurns: HarnessTurnInput[] = []
  const bTurns: HarnessTurnInput[] = []
  let aRequested = false
  let bSawRequest: RoomEvent["collab"] | undefined

  const adapterA: HarnessAdapter = {
    name: "opencode",
    async ensureSession() {},
    async runTurn(input) {
      aTurns.push(input)
      const peer = input.room.participants?.find(
        (participant) =>
          participant.advertised?.includes("browser.authenticated") === true
      )
      if (peer && !aRequested) {
        aRequested = true
        await runtimeARef!.collabRequest({
          targetParticipantId: peer.id,
          summary: "Check the deployed page in your browser",
        })
        return { text: "requested a UI check" }
      }
      return { text: "standing by" }
    },
    async close() {},
  }

  let runtimeARef: ResidentRoomRuntime | null = null
  const runtimeA = new ResidentRoomRuntime({
    instanceId: "inst-create-a",
    name: "Agent A",
    client: clientFor(server, "agent-a"),
    adapter: adapterA,
    capabilities: ["code.edit", "github"],
  })
  runtimeARef = runtimeA
  let runtimeB: ResidentRoomRuntime | null = null

  try {
    // Creator becomes participant #1 of an ordinary room; the public invite
    // carries only room identity.
    const created = await runtimeA.startByCreate()
    assert.equal(created.invite.kind, "free4chat.room-invite")
    assert.equal(created.invite.version, 1)
    assert.equal(created.invite.roomId, server.roomId)
    assert.match(
      created.invite.roomUrl,
      /^https:\/\/www\.free4\.chat\/room\?id=/
    )
    // The public invite must never carry the private capability; the full
    // create result may (it stays inside the runtime), the descriptor may not.
    assert.equal(JSON.stringify(created.invite).includes("handle-"), false)

    // B joins through the normal bootstrap path using the invite's roomId.
    runtimeB = new ResidentRoomRuntime({
      instanceId: "inst-create-b",
      roomId: created.invite.roomId,
      name: "Agent B",
      client: clientFor(server, "agent-b"),
      adapter: {
        name: "hermes",
        async ensureSession() {},
        async runTurn(input) {
          bTurns.push(input)
          const request = input.events.find(
            (event) => event.collab?.kind === "request"
          )?.collab
          if (request) {
            bSawRequest = request
            return { text: "accepted" }
          }
          return { text: "hello from B" }
        },
        async close() {},
      },
      capabilities: ["browser.control", "browser.authenticated"],
    })
    await runtimeB.start()

    // Ordinary addressed chat wakes A; its harness discovers B and targets it.
    server.seedText("agent-b", ["agent-a"], "ready")
    await settle(() => bSawRequest !== undefined)
  } finally {
    await runtimeA.stop()
    if (runtimeB) await runtimeB.stop()
  }

  assert.ok(aRequested)
  assert.ok(bSawRequest)
  assert.equal(bSawRequest.targetParticipantId, "agent-b")
  assert.equal(bSawRequest.fromParticipantId, "agent-a")
  const bRequestTurn = bTurns.find((turn) =>
    turn.events.some((event) => event.collab?.kind === "request")
  )
  assert.ok(bRequestTurn)
})
