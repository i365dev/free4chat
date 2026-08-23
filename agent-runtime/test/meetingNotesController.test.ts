import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createWeriftPeerConnection,
  type PeerConnectionLike,
} from "../src/media/peerConnectionLike.js"
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
  /** When set, createAgentSession() awaits this before resolving/rejecting
   * — lets tests deterministically hold a bridge.start() call open to
   * exercise MeetingNotesController's race windows. */
  createAgentSessionGate: Promise<void> | undefined

  async createAgentSession(): Promise<string> {
    this.createAgentSessionCalls += 1
    if (this.createAgentSessionGate) await this.createAgentSessionGate
    if (this.createAgentSessionError) throw this.createAgentSessionError
    return "agent-session-1"
  }
  async establishDataChannelTransport() {
    return {
      sessionDescription: { type: "answer", sdp: "fake-transport-answer" },
    }
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
  prepareReceiveOnlyAudio(): void {}
  prepareServerEventsDataChannel(): void {}
  async waitForConnection(): Promise<void> {}
  async createOffer(): Promise<SessionDescriptionLike> {
    return { type: "offer", sdp: "fake-initial-offer" }
  }
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
  roomInfoResponse: RoomInfo = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: false },
  }
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
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()

  assert.equal(restClient.createAgentSessionCalls, 1)
  assert.equal(controller.state, "running")
  await controller.stop()
  assert.equal(controller.state, "idle")
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
    meetingNotesMediaAvailable: true,
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
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  assert.equal(restClient.createAgentSessionCalls, 1)

  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: false },
  }
  await controller.poll()

  assert.equal(pc.closed, true)
  await controller.stop()
})

test("repeated polling while authorized does not start a duplicate bridge", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
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
    meetingNotesMediaAvailable: true,
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

  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: false },
  }
  await controller.poll()
  assert.equal(pc1.closed, true)

  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
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
    meetingNotesMediaAvailable: true,
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
    meetingNotesMediaAvailable: true,
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
    meetingNotesMediaAvailable: true,
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

test("the default (non-test) construction resolves createPeerConnection to the real werift factory", () => {
  const client = new FakeClient()
  const restClient = new FakeRestClient()
  // Deliberately does NOT override createPeerConnection — this is exactly
  // the shape ResidentRoomRuntime's real production wiring uses. Asserting
  // the resolved reference is purely structural: it never invokes the
  // factory, so this never touches werift/ICE or the network.
  const controller = new MeetingNotesController({
    client,
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: () => undefined,
    restClient,
  })
  assert.equal(
    controller.resolvedCreatePeerConnection,
    createWeriftPeerConnection
  )
})

test("Stop while bridge.start() is still in flight closes it and it never becomes running", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  let releaseGate: () => void = () => undefined
  restClient.createAgentSessionGate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  const startPromise = controller.start()
  // Let the microtask chain (start -> poll -> ensureRunning ->
  // bridge.start -> createAgentSession) run all the way up to the gate
  // before Stop fires, without resolving it ourselves.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(pc.closed, false) // start() hasn't settled yet — nothing to close

  const stopPromise = controller.stop()
  // stop() must resolve promptly — it must not block on the still-pending
  // bridge.start() call it is superseding.
  await stopPromise
  assert.equal(pc.closed, false) // still pending — closing it now would race SfuMediaBridge's own internal state

  releaseGate()
  await startPromise // the superseded ensureRunning() now settles and self-closes

  assert.equal(pc.closed, true)
  assert.equal(restClient.createAgentSessionCalls, 1)

  // The controller is fully stopped and idle — a later authorized poll can
  // start a genuinely fresh bridge (retryable, not wedged).
  restClient.createAgentSessionGate = undefined
  const pc2 = new FakePeerConnection()
  const controller2 = new MeetingNotesController({
    client,
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: () => undefined,
    restClient,
    createPeerConnection: () => pc2,
    pollIntervalMs: 1_000_000,
  })
  await controller2.start()
  assert.equal(restClient.createAgentSessionCalls, 2)
  await controller2.stop()
})

test("overlapping polls while a start is in flight never create a second bridge/session", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  let releaseGate: () => void = () => undefined
  restClient.createAgentSessionGate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  const startPromise = controller.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  // A second poll tick fires while the first is still starting (e.g. the
  // interval firing before the initial poll settled).
  const secondPoll = controller.poll()
  releaseGate()
  await Promise.all([startPromise, secondPoll])

  assert.equal(restClient.createAgentSessionCalls, 1)
  await controller.stop()
})

test("the master switch (meetingNotesMediaAvailable) being off is treated as revocation even while the room grant is still active", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const { controller } = makeController(client, restClient, pc)

  await controller.start()
  assert.equal(restClient.createAgentSessionCalls, 1)

  // The room-visible grant itself never changed — only the environment-wide
  // master switch flipped off (e.g. an emergency disable) — but the
  // cooperative Runtime must still stop within one poll cycle rather than
  // keeping the bridge alive on a now-meaningless "active" grant.
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: false,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  await controller.poll()

  assert.equal(pc.closed, true)
  await controller.stop()
})

test("Stop then Start for the same Agent between two polls tears down and recreates the bridge (grant epoch changed)", async () => {
  const client = new FakeClient()
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 1 },
  }
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  const controller = new MeetingNotesController({
    client,
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: () => undefined,
    restClient,
    createPeerConnection: () => pc,
    pollIntervalMs: 1_000_000,
  })

  await controller.start()
  assert.equal(restClient.createAgentSessionCalls, 1)
  assert.equal(pc.closed, false)

  // The room went Stop -> Start for the *same* agent entirely between two
  // Runtime polls — this controller only samples room_info periodically,
  // so it never observed the intermediate `active: false`. From its
  // perspective, `meetingNotes` still just says "agent-1 is authorized" —
  // but the server already closed the previous grant's SFU subscriptions
  // (epoch 1 -> epoch 2 is the only visible signal of that).
  client.roomInfoResponse = {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: { active: true, agentParticipantId: "agent-1", startedAt: 2 },
  }
  await controller.poll()

  // The stale bridge (built for epoch 1) is torn down...
  assert.equal(pc.closed, true)
  // ...and a fresh subscription is established for the new grant, not
  // silently treated as "already running, nothing to do".
  assert.equal(restClient.createAgentSessionCalls, 2)

  await controller.stop()
})
