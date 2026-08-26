import assert from "node:assert/strict"
import { test } from "node:test"

import type {
  MediaCodecLike,
  MediaTrackLike,
  PeerConnectionLike,
} from "../src/media/peerConnectionLike.js"
import type {
  RoomMediaParticipant,
  SessionDescriptionLike,
  SfuRestClientLike,
  SfuSignalPurpose,
} from "../src/media/sfuRestClient.js"
import { SfuMediaBridge } from "../src/media/sfuMediaBridge.js"
import type { MediaBridgeEvent } from "../src/media/types.js"
import type { AudioFrame, AudioSource } from "../src/media/types.js"

function fakeHandle() {
  return { room: "room-1", participantId: "agent-1", participantToken: "t" }
}

/** A fake restClient whose roomMedia() response can be swapped between
 * calls, so tests can simulate a Human joining/leaving/reconnecting. */
class FakeRestClient implements SfuRestClientLike {
  participants: RoomMediaParticipant[] = []
  subscribeCalls: Array<{
    sessionId: string
    trackName: string
    purpose?: SfuSignalPurpose
  }> = []
  subscribeMids: string[] = []
  subscribeErrors = new Map<string, Error>()
  establishTransportCalls: Array<{
    sessionId: string
    offer?: SessionDescriptionLike
    purpose?: SfuSignalPurpose
  }> = []
  renegotiateCalls = 0
  renegotiatePurposes: SfuSignalPurpose[] = []
  publishCalls: Array<{ trackName: string; mid: string }> = []
  createAgentSessionError: Error | undefined
  establishTransportError: Error | undefined
  roomMediaError: Error | undefined
  createAgentSessionCalls = 0

  async createAgentSession(): Promise<string> {
    this.createAgentSessionCalls += 1
    if (this.createAgentSessionError) throw this.createAgentSessionError
    return "agent-session-1"
  }
  async establishDataChannelTransport(
    mySessionId: string,
    offer: SessionDescriptionLike | undefined,
    purpose: SfuSignalPurpose
  ) {
    this.establishTransportCalls.push({
      sessionId: mySessionId,
      ...(offer ? { offer } : {}),
      purpose,
    })
    if (this.establishTransportError) throw this.establishTransportError
    return {
      sessionDescription: { type: "answer", sdp: "fake-transport-answer" },
    }
  }
  async roomMedia(): Promise<RoomMediaParticipant[]> {
    if (this.roomMediaError) throw this.roomMediaError
    return this.participants
  }
  async subscribeTrack(
    mySessionId: string,
    remoteSessionId: string,
    trackName: string,
    purpose: SfuSignalPurpose
  ): Promise<SessionDescriptionLike> {
    this.subscribeCalls.push({
      sessionId: remoteSessionId,
      trackName,
      purpose,
    })
    const error = this.subscribeErrors.get(trackName)
    if (error) throw error
    const mid = this.subscribeMids[this.subscribeCalls.length - 1]
    return mid
      ? { type: "offer", sdp: "fake-sdp", mid }
      : { type: "offer", sdp: "fake-sdp" }
  }
  async renegotiate(
    _mySessionId: string,
    _answer: SessionDescriptionLike,
    purpose: SfuSignalPurpose
  ): Promise<void> {
    this.renegotiateCalls += 1
    this.renegotiatePurposes.push(purpose)
  }
  async publishAudioTrack(
    _mySessionId: string,
    args: { trackName: string; mid: string; offer: SessionDescriptionLike }
  ): Promise<{ sessionDescription?: SessionDescriptionLike }> {
    this.publishCalls.push({ trackName: args.trackName, mid: args.mid })
    return {
      sessionDescription: { type: "offer", sdp: "fake-publish-offer" },
    }
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
  localDescriptions: SessionDescriptionLike[] = []
  codec: MediaCodecLike | undefined
  lastRtpCallback: RtpCallback | undefined
  localPublishMidResult: string | undefined
  activatePublishCalls = 0
  private trackHandlers: Array<(track: MediaTrackLike) => void> = []
  onTrack = {
    subscribe: (callback: (track: MediaTrackLike) => void) => {
      this.trackHandlers.push(callback)
    },
  }

  async localPublishMid(): Promise<string | undefined> {
    return this.localPublishMidResult
  }
  async activatePublish(): Promise<void> {
    this.activatePublishCalls += 1
  }
  writePcmChunk = async () => undefined

  async createOffer(): Promise<SessionDescriptionLike> {
    return { type: "offer", sdp: "fake-initial-offer" }
  }

  async setRemoteDescription(
    description: SessionDescriptionLike
  ): Promise<void> {
    // The initial server-offer DataChannel transport does not add a media
    // track. Only a later /tracks subscription offer should fire onTrack.
    if (description.sdp !== "fake-sdp") return
    const track: MediaTrackLike = {
      kind: "audio",
      codec: this.codec,
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
  async setLocalDescription(
    description: SessionDescriptionLike
  ): Promise<void> {
    this.localDescriptions.push(description)
  }
  close(): void {
    this.closed = true
  }
}

/** Production werift can deliver onTrack after the SDP calls resolve. This
 * fake deliberately delays each event so attribution tests do not accidentally
 * rely on the synchronous behavior above. */
class DelayedPeerConnection implements PeerConnectionLike {
  private readonly trackHandlers: Array<(track: MediaTrackLike) => void> = []
  private readonly pendingTracks: MediaTrackLike[] = []
  readonly rtpCallbacks: RtpCallback[] = []
  closed = false
  codec: MediaCodecLike = {
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  }

  onTrack = {
    subscribe: (callback: (track: MediaTrackLike) => void) => {
      this.trackHandlers.push(callback)
    },
  }

  async createOffer(): Promise<SessionDescriptionLike> {
    return { type: "offer", sdp: "fake-initial-offer" }
  }

  async setRemoteDescription(
    description: SessionDescriptionLike
  ): Promise<void> {
    // As above, transport bootstrap is not a subscribed media track.
    if (description.sdp !== "fake-sdp") return
    const track: MediaTrackLike = {
      kind: "audio",
      codec: this.codec,
      onReceiveRtp: {
        subscribe: (handler) => {
          this.rtpCallbacks.push(handler as RtpCallback)
        },
      },
    }
    this.pendingTracks.push(track)
  }

  emitNextTrack(mid?: string): void {
    const track = this.pendingTracks.shift()
    assert.ok(track, "expected a pending delayed track")
    if (!track) return
    track.mid = mid
    for (const handler of this.trackHandlers) handler(track)
  }

  /** Emits the currently pending track without consuming it. This models a
   * stale onTrack callback arriving before the newly negotiated m-line. */
  emitTrackWithMid(mid: string): void {
    const track = this.pendingTracks[0]
    assert.ok(track, "expected a pending delayed track")
    if (!track) return
    track.mid = mid
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    if (process.env.FREE4CHAT_MCP_DEBUG === "1" && attempt % 20 === 0)
      console.error(
        "[dbg-wait]",
        condition.toString().slice(0, 80),
        "=>",
        condition()
      )
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (process.env.FREE4CHAT_MCP_DEBUG === "1")
    console.error(
      "[dbg-wait-final]",
      condition.toString().slice(0, 120),
      "=>",
      condition()
    )
  assert.fail("condition did not become true")
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
  now?: () => number,
  onAudioFrame?: (source: AudioSource, frame: AudioFrame) => void,
  options?: { pollIntervalMs?: number }
) {
  const events: MediaBridgeEvent[] = []
  const bridge = new SfuMediaBridge({
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: (event) => events.push(event),
    restClient,
    createPeerConnection: () => pc,
    ...(now ? { now } : {}),
    ...(onAudioFrame ? { onAudioFrame } : {}),
    ...(options?.pollIntervalMs
      ? { pollIntervalMs: options.pollIntervalMs }
      : {}),
  })
  return { bridge, events }
}

test("raw negotiated Opus reaches only the dedicated audio callback with attribution and copied bytes", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  pc.codec = { mimeType: "audio/opus", clockRate: 48000, channels: 2 }
  const frames: Array<{ source: AudioSource; frame: AudioFrame }> = []
  const { bridge, events } = makeBridge(
    restClient,
    pc,
    undefined,
    (source, frame) => frames.push({ source, frame })
  )

  await bridge.start()
  const rtp = pc.lastRtpCallback
  assert.ok(rtp)
  if (!rtp) return
  const payload = new Uint8Array([1, 2, 3])
  rtp({ payload, header: { timestamp: 480 } })
  payload[0] = 99

  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0]?.source, {
    participantId: "human-1",
    participantName: "human-1",
    trackName: "audio-1",
  })
  assert.equal(frames[0]?.frame.codec, "opus")
  assert.equal(frames[0]?.frame.sampleRateHz, 48000)
  assert.equal(frames[0]?.frame.channels, 2)
  assert.equal(frames[0]?.frame.timestampMs, 10)
  assert.deepEqual(
    [...((frames[0]?.frame.data ?? new Uint8Array()) as Uint8Array)],
    [1, 2, 3]
  )
  assert.equal(
    events.some((event) => "data" in event),
    false
  )
  assert.equal(
    events.filter((event) => event.type === "audioFrameStats").length,
    1
  )
  bridge.stop()
})

test("raw audio callback is omitted when negotiated metadata is unavailable", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [humanTrack("human-1", "sess-1")]
  const pc = new FakePeerConnection()
  let callbacks = 0
  const { bridge } = makeBridge(restClient, pc, undefined, () => {
    callbacks += 1
  })
  await bridge.start()
  pc.lastRtpCallback?.({
    payload: new Uint8Array([1]),
    header: { timestamp: 1 },
  })
  assert.equal(callbacks, 0)
  bridge.stop()
})

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
    purpose: "meeting-notes",
  })
  assert.deepEqual(restClient.establishTransportCalls, [
    {
      sessionId: "agent-session-1",
      offer: { type: "offer", sdp: "fake-initial-offer" },
      purpose: "agent-transport",
    },
  ])
  assert.equal(restClient.renegotiateCalls, 1)
  // The subscribe renegotiation must carry the Meeting Notes purpose.
  assert.deepEqual(restClient.renegotiatePurposes, ["meeting-notes"])
  const started = events.find((e) => e.type === "audioTrackStarted")
  assert.ok(started)
  assert.equal(started.participantId, "human-1")
  bridge.stop()
})

test("#83 review: publication negotiates and renegotiates under the voice-reply purpose only", async () => {
  const restClient = new FakeRestClient()
  const pc = new FakePeerConnection()
  pc.localPublishMidResult = "mid-pub-1"
  const events: MediaBridgeEvent[] = []
  const bridge = new SfuMediaBridge({
    mcpUrl: "https://www.free4.chat/mcp",
    handle: fakeHandle(),
    onEvent: (event) => events.push(event),
    restClient,
    createPeerConnection: () => pc,
    publish: { trackName: "agent-voice" },
  })

  await bridge.start()
  assert.equal(bridge.voicePublishCapable, true)
  await bridge.activateVoicePublish()

  assert.deepEqual(restClient.publishCalls, [
    { trackName: "agent-voice", mid: "mid-pub-1" },
  ])
  // The publication's answer flow must be renegotiated under voice-reply,
  // never meeting-notes or agent-transport.
  assert.ok(restClient.renegotiatePurposes.includes("voice-reply"))
  assert.equal(pc.activatePublishCalls, 1)
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

test("a stale remote track failure does not terminate the bridge or block other tracks", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [
    humanTrack("gone", "expired-session", "audio-gone"),
    humanTrack("live", "live-session", "audio-live"),
  ]
  restClient.subscribeErrors.set(
    "audio-gone",
    new Error("SFU request failed (410)")
  )
  const pc = new FakePeerConnection()
  const { bridge, events } = makeBridge(restClient, pc)

  await bridge.start()

  assert.deepEqual(
    restClient.subscribeCalls.map(({ sessionId, trackName }) => ({
      sessionId,
      trackName,
    })),
    [
      { sessionId: "expired-session", trackName: "audio-gone" },
      { sessionId: "live-session", trackName: "audio-live" },
    ]
  )
  assert.equal(pc.closed, false)
  assert.deepEqual(
    events
      .filter((event) => event.type === "audioTrackStarted")
      .map((event) => event.participantId),
    ["live"]
  )
  bridge.stop()
})

test("delayed onTrack events preserve attribution across serialized subscriptions", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [
    humanTrack("human-1", "sess-1"),
    humanTrack("human-2", "sess-2"),
  ]
  const pc = new DelayedPeerConnection()
  const frames: AudioSource[] = []
  const { bridge, events } = makeBridge(restClient, pc, undefined, (source) => {
    frames.push(source)
  })

  // Both negotiations complete up-front under the new lifecycle (#100 P1-4);
  // media start (OnTrack) may arrive later, in any order, and attribution
  // must follow each track's negotiated MID.
  await bridge.start()
  assert.equal(restClient.subscribeCalls.length, 2)

  pc.emitNextTrack("mid-1")
  await waitFor(
    () =>
      events.filter(
        (e) => e.type === "audioTrackStarted" && e.participantId === "human-1"
      ).length === 1
  )

  pc.emitNextTrack("mid-2")
  await waitFor(
    () =>
      events.filter(
        (e) => e.type === "audioTrackStarted" && e.participantId === "human-2"
      ).length === 1
  )
  await waitFor(() => pc.rtpCallbacks.length === 2)

  pc.rtpCallbacks[0]?.({
    payload: new Uint8Array([1]),
    header: { timestamp: 1 },
  })
  pc.rtpCallbacks[1]?.({
    payload: new Uint8Array([2]),
    header: { timestamp: 2 },
  })
  assert.deepEqual(
    frames.map((source) => source.participantId),
    ["human-1", "human-2"]
  )
  bridge.stop()
})

test("track attribution ignores stale onTrack callbacks from another mid", async () => {
  const restClient = new FakeRestClient()
  restClient.participants = [
    humanTrack("human-1", "sess-1"),
    humanTrack("human-2", "sess-2"),
  ]
  restClient.subscribeMids = ["mid-1", "mid-2"]
  const pc = new DelayedPeerConnection()
  const frames: AudioSource[] = []
  const { bridge, events } = makeBridge(restClient, pc, undefined, (source) => {
    frames.push(source)
  })

  await bridge.start()
  assert.equal(restClient.subscribeCalls.length, 2)

  // A stale onTrack from an unregistered MID must not bind anything.
  pc.emitTrackWithMid("old-mid")
  assert.equal(events.filter((e) => e.type === "audioTrackStarted").length, 0)

  pc.emitNextTrack("mid-1")
  await waitFor(
    () =>
      events.filter(
        (e) => e.type === "audioTrackStarted" && e.participantId === "human-1"
      ).length === 1
  )
  // A duplicate stale callback for an already-bound MID is also ignored.
  pc.emitTrackWithMid("mid-1")
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(events.filter((e) => e.type === "audioTrackStarted").length, 1)

  pc.emitNextTrack("mid-2")
  await waitFor(
    () =>
      events.filter(
        (e) => e.type === "audioTrackStarted" && e.participantId === "human-2"
      ).length === 1
  )
  await waitFor(() => pc.rtpCallbacks.length === 2)
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
    true,
    "peer connection is created before session setup now (it produces the offer), so a failed start must roll it back"
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

test("#83 review: VR-only bootstrap succeeds without Human-media discovery; a later MN grant reuses the same session", async () => {
  const restClient = new FakeRestClient()
  // The DO denies agent-room-media for an agent with no Meeting Notes grant.
  restClient.roomMediaError = new Error("meeting_notes_not_authorized")
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc, undefined, undefined, {
    pollIntervalMs: 3_600_000,
  })

  await bridge.start()
  assert.equal(restClient.createAgentSessionCalls, 1)
  assert.deepEqual(
    restClient.establishTransportCalls.map((call) => call.purpose),
    ["agent-transport"]
  )
  assert.equal(restClient.subscribeCalls.length, 0)
  assert.equal(pc.closed, false)

  // Meeting Notes granted afterwards: the SAME session starts pulling the
  // newly visible Human audio on the next poll tick.
  restClient.roomMediaError = undefined
  restClient.participants = [humanTrack("human-1", "sess-1")]
  await bridge.poll()
  assert.equal(restClient.subscribeCalls.length, 1)
  assert.equal(restClient.subscribeCalls[0].purpose, "meeting-notes")
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

test("failed start() (transport bootstrap) closes the peer connection and is retryable", async () => {
  const restClient = new FakeRestClient()
  restClient.establishTransportError = new Error("boom: transport bootstrap")
  const pc = new FakePeerConnection()
  const { bridge } = makeBridge(restClient, pc)

  await assert.rejects(() => bridge.start(), /boom: transport bootstrap/)
  assert.equal(pc.closed, true)

  restClient.establishTransportError = undefined
  restClient.participants = [humanTrack("human-1", "sess-1")]
  await bridge.start()
  assert.equal(restClient.subscribeCalls.length, 1)
  bridge.stop()
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
