import assert from "node:assert/strict"
import { test } from "node:test"

import type { PeerConnectionLike } from "../src/media/peerConnectionLike.js"
import { MeetingNotesController } from "../src/media/meetingNotesController.js"
import type {
  RoomMediaParticipant,
  SessionDescriptionLike,
  SfuRestClientLike,
} from "../src/media/sfuRestClient.js"
import type { MediaBridgeEvent } from "../src/media/types.js"
import type {
  Free4ChatClient,
  JoinResult,
  RoomInfo,
  WaitResult,
} from "../src/types.js"

function fakeHandle() {
  return { room: "room-1", participantId: "agent-1", participantToken: "t" }
}

class FakeRestClient implements SfuRestClientLike {
  participants: RoomMediaParticipant[] = []
  createAgentSessionCalls = 0
  createAgentSessionError: Error | undefined

  async createAgentSession(): Promise<string> {
    this.createAgentSessionCalls += 1
    if (this.createAgentSessionError) throw this.createAgentSessionError
    return "agent-session-1"
  }
  async roomMedia(): Promise<RoomMediaParticipant[]> {
    return this.participants
  }
  async subscribeTrack(): Promise<SessionDescriptionLike> {
    return { type: "offer", sdp: "fake-offer" }
  }
  async renegotiate(): Promise<void> {}
}

class FakePeerConnection implements PeerConnectionLike {
  closed = false
  onTrack = { subscribe: () => undefined }
  async setRemoteDescription(): Promise<void> {}
  async createAnswer(): Promise<SessionDescriptionLike> {
    return { type: "answer", sdp: "fake-answer" }
  }
  async setLocalDescription(): Promise<void> {}
  close(): void {
    this.closed = true
  }
}

/** A fake Free4ChatClient whose roomInfo() response can be swapped between
 * calls, so tests can simulate Meeting Notes being started/stopped. */
class FakeClient implements Free4ChatClient {
  roomInfoResponse: RoomInfo = { exists: true, meetingNotes: { active: false } }
  roomInfoError: Error | undefined
  roomInfoCalls = 0

  async connect(): Promise<void> {}
  async listTools(): Promise<string[]> {
    return []
  }
  async roomInfo(): Promise<RoomInfo> {
    this.roomInfoCalls += 1
    if (this.roomInfoError) throw this.roomInfoError
    return this.roomInfoResponse
  }
  async joinRoom(): Promise<JoinResult> {
    throw new Error("not used by these tests")
  }
  async waitForEvents(): Promise<WaitResult> {
    throw new Error("not used by these tests")
  }
  async sendText(): Promise<{ sequence: number }> {
    throw new Error("not used by these tests")
  }
  async readAttachment(): Promise<{ data: string; mimeType: string }> {
    throw new Error("not used by these tests")
  }
  async leaveRoom(): Promise<void> {}
  async close(): Promise<void> {}
}

function makeController(
  client: FakeClient,
  restClient: FakeRestClient,
  pc: FakePeerConnection
) {
  const events: MediaBridgeEvent[] = []
  const controller = new MeetingNotesController({
    client,
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: (event) => events.push(event),
    restClient,
    createPeerConnection: () => pc,
    pollIntervalMs: 1_000_000, // never fire on its own during tests; we call poll() directly
  })
  return { controller, events }
}

test("an authorized grant starts the MediaBridge", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()

  assert.equal(restClient.createAgentSessionCalls, 1)
  await controller.stop()
})

test("no grant never starts the MediaBridge", async () => {
  const client = new FakeClient() // default: inactive
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  await controller.poll()

  assert.equal(restClient.createAgentSessionCalls, 0)
  await controller.stop()
})

test("a grant for a different agent never starts the MediaBridge", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-2", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()

  assert.equal(restClient.createAgentSessionCalls, 0)
  await controller.stop()
})

test("revocation stops the MediaBridge and closes the peer connection", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  assert.equal(restClient.createAgentSessionCalls, 1)

  client.roomInfoResponse = { exists: true, meetingNotes: { active: false } }
  await controller.poll()

  assert.equal(pc.closed, true)
  await controller.stop()
})

test("repeated polling while authorized does not start a duplicate bridge", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  await controller.poll()
  await controller.poll()

  assert.equal(restClient.createAgentSessionCalls, 1)
  await controller.stop()
})

test("resync: active -> revoked -> active again restarts a fresh bridge each time", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc1 = new FakePeerConnection()
  const controller = new MeetingNotesController({
    client,
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: () => undefined,
    restClient,
    createPeerConnection: () => pc1,
    pollIntervalMs: 1_000_000,
  })

  await controller.start()
  assert.equal(restClient.createAgentSessionCalls, 1)

  client.roomInfoResponse = { exists: true, meetingNotes: { active: false } }
  await controller.poll()
  assert.equal(pc1.closed, true)

  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 2 },
  }
  await controller.poll()
  assert.equal(restClient.createAgentSessionCalls, 2)

  await controller.stop()
})

test("a room_info failure fails closed: does not start, and stops an already-running bridge", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  assert.equal(restClient.createAgentSessionCalls, 1)

  client.roomInfoError = new Error("network blip")
  await controller.poll()

  assert.equal(pc.closed, true)
  await controller.stop()
})

test("a failed MediaBridge start is caught, logged, and does not throw — next poll can still succeed", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  restClient.createAgentSessionError = new Error("boom")
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start() // must not throw
  assert.equal(restClient.createAgentSessionCalls, 1)

  restClient.createAgentSessionError = undefined
  await controller.poll()
  assert.equal(restClient.createAgentSessionCalls, 2)

  await controller.stop()
})

test("stop() tears down a running bridge and future polls do nothing", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  await controller.stop()
  assert.equal(pc.closed, true)

  const callsBefore = client.roomInfoCalls
  await controller.poll()
  assert.equal(client.roomInfoCalls, callsBefore) // poll() is a no-op once stopped
})
