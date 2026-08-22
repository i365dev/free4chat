import type {
  PeerConnectionFactory,
  PeerConnectionLike,
} from "./peerConnectionLike.js"
import type { DecodedParticipantHandle } from "./participantHandle.js"
import { SfuRestClient, siteOriginFromMcpUrl } from "./sfuRestClient.js"
import type {
  RoomMediaParticipant,
  SfuRestClientLike,
} from "./sfuRestClient.js"
import type { MediaBridgeEventHandler } from "./types.js"

const DEFAULT_POLL_INTERVAL_MS = 5000
/** Emit a bounded stats event at most this often per track, not per packet. */
const STATS_FLUSH_INTERVAL_MS = 2000

export interface SfuMediaBridgeOptions {
  /** Base MCP URL (same env var/default as the rest of the Runtime) or an
   * explicit site origin — either works, only the origin is used. */
  mcpUrl: string
  handle: DecodedParticipantHandle
  onEvent: MediaBridgeEventHandler
  pollIntervalMs?: number
  restClient?: SfuRestClientLike
  createPeerConnection?: PeerConnectionFactory
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number
}

interface TrackSubscription {
  key: string
  participantId: string
  participantName: string
  trackName: string
  frameCount: number
  byteCount: number
  firstTimestamp?: number
  lastTimestamp?: number
  sampleRateHz: number
  lastFlushAt: number
}

function subscriptionKey(
  participantId: string,
  sessionId: string,
  trackName: string
): string {
  return `${participantId}:${sessionId}:${trackName}`
}

/**
 * Phase 0 (#82) SFU audio-ingress capability for a resident Agent. Joins the
 * current room's Cloudflare Realtime SFU session as a subscribe-only
 * participant and reports bounded diagnostics as Human audio tracks appear.
 * No STT, no persistence, no publishing — see README/PR for the full
 * boundary. This class owns no Harness-visible state; the Runtime wires its
 * events wherever it chooses (currently: nowhere but the manual PoC script).
 */
export class SfuMediaBridge {
  private readonly restClient: SfuRestClientLike
  private readonly createPeerConnection: PeerConnectionFactory
  private readonly onEvent: MediaBridgeEventHandler
  private readonly pollIntervalMs: number
  private readonly now: () => number

  private pc: PeerConnectionLike | null = null
  private mySessionId: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = true
  private negotiationQueue: Promise<void> = Promise.resolve()
  private pendingSubscription: {
    key: string
    participantId: string
    participantName: string
    trackName: string
  } | null = null
  private readonly subscriptions = new Map<string, TrackSubscription>()

  constructor(options: SfuMediaBridgeOptions) {
    this.onEvent = options.onEvent
    this.now = options.now ?? Date.now
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.restClient =
      options.restClient ??
      new SfuRestClient(siteOriginFromMcpUrl(options.mcpUrl), options.handle)
    this.createPeerConnection =
      options.createPeerConnection ??
      (() => {
        throw new Error(
          "createPeerConnection is required outside of tests (see peerConnectionLike.ts's createWeriftPeerConnection)"
        )
      })
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.mySessionId = await this.restClient.createAgentSession()
    this.pc = await this.createPeerConnection()
    this.pc.onTrack.subscribe((track) => this.handleIncomingTrack(track))
    await this.poll()
    this.pollTimer = setInterval(() => {
      void this.poll().catch(() => undefined)
    }, this.pollIntervalMs)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    for (const subscription of this.subscriptions.values()) {
      this.onEvent({
        type: "audioTrackEnded",
        participantId: subscription.participantId,
        trackName: subscription.trackName,
        reason: "bridge_stopped",
      })
    }
    this.subscriptions.clear()
    this.pc?.close()
    this.pc = null
    this.mySessionId = null
  }

  /** Exposed for tests; also called internally on the poll timer. */
  async poll(): Promise<void> {
    const participants = await this.restClient.roomMedia()
    this.reconcileEnded(participants)
    const pending: Promise<void>[] = []
    for (const participant of participants) {
      for (const track of participant.tracks) {
        if (track.kind !== "audio") continue
        pending.push(
          this.subscribe(participant, track.trackName).catch(() => undefined)
        )
      }
    }
    await Promise.all(pending)
  }

  private reconcileEnded(participants: RoomMediaParticipant[]): void {
    const liveKeys = new Set(
      participants.flatMap((participant) =>
        participant.tracks
          .filter((track) => track.kind === "audio")
          .map((track) =>
            subscriptionKey(
              participant.participantId,
              participant.sessionId,
              track.trackName
            )
          )
      )
    )
    for (const [key, subscription] of [...this.subscriptions.entries()]) {
      if (liveKeys.has(key)) continue
      this.subscriptions.delete(key)
      this.onEvent({
        type: "audioTrackEnded",
        participantId: subscription.participantId,
        trackName: subscription.trackName,
        reason: "participant_left",
      })
    }
  }

  private subscribe(
    participant: RoomMediaParticipant,
    trackName: string
  ): Promise<void> {
    const key = subscriptionKey(
      participant.participantId,
      participant.sessionId,
      trackName
    )
    if (this.subscriptions.has(key)) return Promise.resolve()
    // Reserve the slot before the negotiation is even queued, so a second
    // poll() tick racing this one can't queue a duplicate subscribe for the
    // same track.
    this.subscriptions.set(key, {
      key,
      participantId: participant.participantId,
      participantName: participant.name,
      trackName,
      frameCount: 0,
      byteCount: 0,
      sampleRateHz: 48000,
      lastFlushAt: 0,
    })

    // WebRTC renegotiation must be serialized — chain onto the same queue
    // used by every other subscribe() call, mirroring the browser client's
    // enqueueNegotiation pattern for this exact protocol.
    const run = this.negotiationQueue.then(async () => {
      if (this.stopped || !this.pc || !this.mySessionId) return
      try {
        this.pendingSubscription = {
          key,
          participantId: participant.participantId,
          participantName: participant.name,
          trackName,
        }
        const offer = await this.restClient.subscribeTrack(
          this.mySessionId,
          participant.sessionId,
          trackName
        )
        await this.pc.setRemoteDescription(offer)
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        await this.restClient.renegotiate(this.mySessionId, answer)
      } catch (error) {
        this.pendingSubscription = null
        this.subscriptions.delete(key)
        throw error
      }
    })
    this.negotiationQueue = run.catch(() => undefined)
    return run
  }

  private handleIncomingTrack(track: {
    kind: "audio" | "video"
    onReceiveRtp: {
      subscribe(
        callback: (packet: {
          payload: Uint8Array
          header: { timestamp: number }
        }) => void
      ): void
    }
  }): void {
    const pending = this.pendingSubscription
    this.pendingSubscription = null
    if (!pending || track.kind !== "audio") return
    const key = pending.key
    const subscription = this.subscriptions.get(key)
    if (!subscription) return

    this.onEvent({
      type: "audioTrackStarted",
      participantId: pending.participantId,
      participantName: pending.participantName,
      trackName: pending.trackName,
    })

    track.onReceiveRtp.subscribe((packet) => {
      if (!this.subscriptions.has(key)) return
      subscription.frameCount += 1
      subscription.byteCount += packet.payload.byteLength
      if (subscription.firstTimestamp === undefined)
        subscription.firstTimestamp = packet.header.timestamp
      subscription.lastTimestamp = packet.header.timestamp

      const now = this.now()
      if (now - subscription.lastFlushAt < STATS_FLUSH_INTERVAL_MS) return
      subscription.lastFlushAt = now
      const spanSamples =
        subscription.lastTimestamp !== undefined &&
        subscription.firstTimestamp !== undefined
          ? subscription.lastTimestamp - subscription.firstTimestamp
          : 0
      const approxFrameDurationMs =
        subscription.frameCount > 1
          ? (spanSamples /
              subscription.sampleRateHz /
              subscription.frameCount) *
            1000
          : 0
      this.onEvent({
        type: "audioFrameStats",
        participantId: subscription.participantId,
        trackName: subscription.trackName,
        frameCount: subscription.frameCount,
        byteCount: subscription.byteCount,
        approxFrameDurationMs,
      })
    })
  }
}
