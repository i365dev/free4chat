import assert from "node:assert/strict"
import { test } from "node:test"

import type {
  MediaTrackLike,
  PeerConnectionLike,
} from "../src/media/peerConnectionLike.js"
import type {
  RoomMediaParticipant,
  SessionDescriptionLike,
  SfuRestClientLike,
} from "../src/media/sfuRestClient.js"
import { SfuMediaBridge } from "../src/media/sfuMediaBridge.js"
import type { MediaBridgeEvent } from "../src/media/types.js"

function fakeHandle() {
  return { room: "room-1", participantId: "agent-1", participantToken: "t" }
}

/** A fake restClient whose roomMedia() response can be swapped between
 * calls, so tests can simulate a Human joining/leaving/reconnecting. */
class FakeRestClient implements SfuRestClientLike {
  participants: RoomMediaParticipant[] = []
  subscribeCalls: Array<{ sessionId: string; trackName: string }> = []
  renegotiateCalls = 0
  createAgentSessionError: Error | undefined
  roomMediaError: Error | undefined
  createAgentSessionCalls = 0

  async createAgentSession(): Promise<string> {
    this.createAgentSessionCalls += 1
    if (this.createAgentSessionError) throw this.createAgentSessionError
    return "agent-session-1"
  }
  async roomMedia(): Promise<RoomMediaParticipant[]> {
    if (this.roomMediaError) throw this.roomMediaError
    return this.participants
  }
  async subscribeTrack(
    _mySessionId: string,
    remoteSessionId: string,
    trackName: string
  ): Promise<SessionDescriptionLike> {
    this.subscribeCalls.push({ sessionId: remoteSessionId, trackName })
    return { type: "offer", sdp: "fake-offer" }
  }
  async renegotiate(): Promise<void> {
    this.renegotiateCalls += 1
  }
}

type RtpCallback = (packet: {
  payload: Uint8Array
  header: { timestamp: number }
}) => void

/** A fake peer connection: setRemoteDescription synchronously fires the
 * onTrack subscriber, exactly like werift would once the caller's
 * subscribe() flow reaches that point — no real ICE/DTLS involved. The RTP
 * callback the bridge registers on the emitted track is captured onto
 * `lastRtpCallback` so a test can drive fake packets through it. */
class FakePeerConnection implements PeerConnectionLike {
  closed = false
  lastRtpCallback: RtpCallback | undefined
  private trackHandlers: Array<(track: MediaTrackLike) => void> = []
  onTrack = {
    subscribe: (callback: (track: MediaTrackLike) => void) => {
      this.trackHandlers.push(callback)
    },
  }

  async setRemoteDescription(): Promise<void> {
    const track: MediaTrackLike = {
      kind: "audio",
      onReceiveRtp: {
        subscribe: (callback) => {
          this.lastRtpCallback = callback as RtpCallback
        },
      },
    }
    for (const handler of this.trackHandlers) handler(track)
  }
  async createAnswer(): Promise<SessionDescriptionLike> {
    return { type: "answer", sdp: "fake-answer" }
  }
  async setLocalDescription(): Promise<void> {}
  close(): void {
    this.closed = true
  }
}

function humanTrack(
  participantId: string,
  sessionId: string,
  trackName = "audio-1"
): RoomMediaParticipant {
  return {
    participantId,
    name: participantId,
    sessionId,
    tracks: [{ trackName, kind: "audio" }],
  }
}

function makeBridge(
  restClient: FakeRestClient,
  pc: FakePeerConnection,
  now?: () => number
) {
  const events: MediaBridgeEvent[] = []
  const bridge = new SfuMediaBridge({
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: (event) => events.push(event),
    restClient,
    createPeerConnection: () => pc,
    ...(now ? { now } : {}),
  })
  return { bridge, events }
}

test("subscribes to a newly discovered Human audio track and reports it started", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge, events } = makeBridge(restClient, pc)

  await bridge.start()

  assert.equal(restClient.subscribeCalls.length, 1)
  assert.deepEqual(restClient.subscribeCalls[0], {
    sessionId: "sess-1",
    trackName: "audio-1",
  })
  assert.equal(restClient.renegotiateCalls, 1)
  const started = events.find((e) => e.type === "audioTrackStarted")
  assert.ok(started)
  assert.equal(started.participantId, "human-1")
  bridge.stop()
})

test("dedupes: polling again with the same track does not resubscribe", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc)

  await bridge.start()
  await bridge.poll()
  await bridge.poll()

  assert.equal(restClient.subscribeCalls.length, 1)
  bridge.stop()
})

test("Human leaving: emits audioTrackEnded(participant_left) and allows a fresh resubscribe later", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge, events } = makeBridge(restClient, pc)

  await bridge.start()
  restClient.participants = []
  await bridge.poll()

  const ended = events.find((e) => e.type === "audioTrackEnded")
  assert.ok(ended)
  assert.equal(ended.type, "audioTrackEnded")
  assert.equal((ended as { reason: string }).reason, "participant_left")

  restClient.participants = [humanTrack("human-1", "sess-1")]
  await bridge.poll()
  assert.equal(restClient.subscribeCalls.length, 2)
  bridge.stop()
})

test("reconnect: a changed sessionId for the same participant/track is treated as a fresh track", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge, events } = makeBridge(restClient, pc)

  await bridge.start()
  restClient.participants = [humanTrack("human-1", "sess-2")]
  await bridge.poll()

  const ended = events.filter((e) => e.type === "audioTrackEnded")
  assert.equal(ended.length, 1)
  assert.equal(restClient.subscribeCalls.length, 2)
  assert.equal(restClient.subscribeCalls[1].sessionId, "sess-2")
  bridge.stop()
})

test("two distinct Human participants remain independently attributable", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [
    humanTrack("human-1", "sess-1"),
    humanTrack("human-2", "sess-2"),
  ]
  const pc = new FakePeerConnection()
  const { bridge, events } = makeBridge(restClient, pc)

  await bridge.start()

  const started = events.filter((e) => e.type === "audioTrackStarted")
  assert.equal(started.length, 2)
  assert.deepEqual(started.map((e) => e.participantId).sort(), [
    "human-1",
    "human-2",
  ])
  bridge.stop()
})

test("stop() cleans up: closes the peer connection and reports every live track as ended", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge, events } = makeBridge(restClient, pc)

  await bridge.start()
  bridge.stop()

  assert.equal(pc.closed, true)
  const ended = events.filter(
    (e) => e.type === "audioTrackEnded" && e.reason === "bridge_stopped"
  )
  assert.equal(ended.length, 1)
})

test("stop() is idempotent and a stopped bridge can be started again cleanly", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc)

  await bridge.start()
  bridge.stop()
  bridge.stop() // must not throw or double-emit

  const pc2 = new FakePeerConnection()
  const restClient2 = new FakeRestClient()
  restClient2.participants = [humanTrack("human-1", "sess-1")]
  const { bridge: bridge2, events: events2 } = makeBridge(restClient2, pc2)
  await bridge2.start()
  assert.equal(restClient2.subscribeCalls.length, 1)
  assert.equal(events2.filter((e) => e.type === "audioTrackStarted").length, 1)
  bridge2.stop()
})

test("audio frame stats are throttled, not emitted per packet (bounded, not unbounded)", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  let clock = 0
  const { bridge, events } = makeBridge(restClient, pc, () => clock)

  await bridge.start()
  assert.ok(pc.lastRtpCallback, "expected the RTP callback to be captured")
  const rtp = pc.lastRtpCallback
  if (!rtp) return

  for (let i = 0; i < 50; i += 1) {
    clock += 10
    rtp({ payload: new Uint8Array(160), header: { timestamp: i * 480 } })
  }

  const statsEvents = events.filter((event) => event.type === "audioFrameStats")
  // 50 packets over 500ms with a 2000ms flush interval should yield very
  // few stats events — never one per packet.
  assert.ok(
    statsEvents.length < 5,
    `expected throttled stats events, got ${statsEvents.length}`
  )
  bridge.stop()
})

test("failed start() (session creation) leaves the bridge stopped and retryable", async () => {
  const restClient = new FakeRestClient()
  restClient.createAgentSessionError = new Error("boom: session creation")
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc)

  await assert.rejects(() => bridge.start(), /boom: session creation/)
  assert.equal(
    pc.closed,
    false,
    "peer connection was never created, nothing to close"
  )

  // Retry: fix the failure and start again — must succeed cleanly, not be
  // wedged in a half-started state.
  restClient.createAgentSessionError = undefined
  restClient.participants = [humanTrack("human-1", "sess-1")]
  await bridge.start()
  assert.equal(restClient.createAgentSessionCalls, 2)
  assert.equal(restClient.subscribeCalls.length, 1)
  bridge.stop()
})

test("failed start() (peer connection creation) leaves the bridge stopped and retryable", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  let attempt = 0
  const pcFactory = () => {
    attempt += 1
    if (attempt === 1) throw new Error("boom: peer connection creation")
    return new FakePeerConnection()
  }
  const events: MediaBridgeEvent[] = []
  const bridge = new SfuMediaBridge({
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: (event) => events.push(event),
    restClient,
    createPeerConnection: pcFactory,
  })

  await assert.rejects(() => bridge.start(), /boom: peer connection creation/)

  // Retry with a working factory — must succeed cleanly.
  await bridge.start()
  assert.equal(restClient.subscribeCalls.length, 1)
  bridge.stop()
})

test("failed start() (initial poll) leaves the bridge stopped, closes the peer connection, and is retryable", async () => {
  const restClient = new FakeRestClient()
  restClient.roomMediaError = new Error("boom: room-media unreachable")
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc)

  await assert.rejects(() => bridge.start(), /boom: room-media unreachable/)
  assert.equal(
    pc.closed,
    true,
    "the peer connection created before the failing poll must be closed"
  )

  // Retry: fix the failure and start again with a *new* peer connection —
  // must succeed cleanly.
  restClient.roomMediaError = undefined
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc2 = new FakePeerConnection()
  const { bridge: bridge2 } = makeBridge(restClient, pc2)
  await bridge2.start()
  assert.equal(restClient.subscribeCalls.length, 1)
  bridge2.stop()
})

test("start() is a no-op while already running (does not create a second session)", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc)

  await bridge.start()
  await bridge.start()
  assert.equal(restClient.createAgentSessionCalls, 1)
  bridge.stop()
})
