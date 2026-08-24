import type {
  PeerConnectionFactory,
  PeerConnectionLike,
} from "./peerConnectionLike.js"
import type { DecodedParticipantHandle } from "./participantHandle.js"
import { SfuRestClient, siteOriginFromMcpUrl } from "./sfuRestClient.js"
import type { SessionDescriptionLike } from "./sfuRestClient.js"
import type {
  RoomMediaParticipant,
  SfuRestClientLike,
} from "./sfuRestClient.js"
import type {
  AudioFrameHandler,
  AudioSource,
  MediaBridgeEventHandler,
} from "./types.js"
import type { MediaTrackLike, RtpPacketLike } from "./peerConnectionLike.js"

const DEFAULT_POLL_INTERVAL_MS = 5000
const INCOMING_TRACK_TIMEOUT_MS = 10000
/** Emit a bounded stats event at most this often per track, not per packet. */
const STATS_FLUSH_INTERVAL_MS = 2000

export interface SfuMediaBridgeOptions {
  /** Base MCP URL (same env var/default as the rest of the Runtime) or an
   * explicit site origin — either works, only the origin is used. */
  mcpUrl: string
  handle: DecodedParticipantHandle
  onEvent: MediaBridgeEventHandler
  /** Optional raw-audio path; never included in MediaBridgeEvent diagnostics. */
  onAudioFrame?: AudioFrameHandler
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
  private readonly onAudioFrame?: AudioFrameHandler
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
    expectedMid?: string
    resolve: (track: MediaTrackLike) => void
    reject: (error: Error) => void
  } | null = null
  private readonly subscriptions = new Map<string, TrackSubscription>()

  constructor(options: SfuMediaBridgeOptions) {
    this.onEvent = options.onEvent
    this.onAudioFrame = options.onAudioFrame
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

  // start() is transactional: if any initialization step fails partway —
  // session creation, peer connection creation, or the first poll — every
  // partial resource is torn down and `stopped` goes back to true before
  // rethrowing, so the bridge is never left "logically started" with a
  // half-built PeerConnection/timer that a caller can neither use nor
  // retry past. A later start() call after a failure begins genuinely
  // fresh (new session, new PeerConnection) rather than trying to resume
  // whatever partially succeeded.
  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    try {
      this.pc = await this.createPeerConnection()
      this.pc.onTrack.subscribe((track) => this.handleIncomingTrack(track))
      // Native initial-offer bootstrap (deployed contract): the gathered
      // local offer rides on session creation itself, and Cloudflare's
      // answer comes straight back. Falls back to the blank-session +
      // datachannels/establish server-offer flow when the deployment only
      // speaks that contract (#101 §3/§4: follow the actual responses).
      const offer = await this.pc.createOffer()
      let description: SessionDescriptionLike | undefined
      if (typeof this.restClient.createAgentSessionWithOffer === "function") {
        const created = await this.restClient.createAgentSessionWithOffer(offer)
        this.mySessionId = created.sessionId
        description = created.sessionDescription
      } else {
        this.mySessionId = await this.restClient.createAgentSession()
      }
      if (!description) {
        const transport = await this.restClient.establishDataChannelTransport(
          this.mySessionId,
          offer
        )
        description = transport.sessionDescription
        if (description && description.type === "offer") {
          await this.pc.setRemoteDescription(description)
          if (transport.requiresImmediateRenegotiation) {
            const answer = await this.pc.createAnswer()
            await this.pc.setLocalDescription(answer)
            await this.restClient.renegotiate(this.mySessionId, answer)
          }
          description = undefined
        }
      }
      if (!description)
        throw new Error("missing_datachannel_session_description")
      if (description.type !== "offer") {
        await this.pc.setRemoteDescription(description)
      } else {
        await this.pc.setRemoteDescription(description)
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        await this.restClient.renegotiate(this.mySessionId, answer)
      }
      await this.poll()
      this.pollTimer = setInterval(() => {
        void this.poll().catch(() => undefined)
      }, this.pollIntervalMs)
    } catch (error) {
      this.resetToStoppedState(false)
      throw error
    }
  }

  stop(): void {
    if (this.stopped) return
    this.resetToStoppedState(true)
  }

  private resetToStoppedState(emitEndedEvents: boolean): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (emitEndedEvents) {
      for (const subscription of this.subscriptions.values()) {
        this.onEvent({
          type: "audioTrackEnded",
          participantId: subscription.participantId,
          trackName: subscription.trackName,
          reason: "bridge_stopped",
        })
      }
    }
    this.subscriptions.clear()
    this.pendingSubscription = null
    this.pc?.close()
    this.pc = null
    this.mySessionId = null
    this.stopped = true
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
      const incomingTrack = new Promise<MediaTrackLike>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (this.pendingSubscription?.key !== key) return
          this.pendingSubscription = null
          reject(new Error("incoming_audio_track_timeout"))
        }, INCOMING_TRACK_TIMEOUT_MS)
        this.pendingSubscription = {
          key,
          participantId: participant.participantId,
          participantName: participant.name,
          trackName,
          resolve: (track) => {
            clearTimeout(timeout)
            resolve(track)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          },
        }
      })
      // subscribeTrack() can fail before the SDP offer has a chance to
      // produce an onTrack callback. Keep a rejection handler attached from
      // creation time so cancelling this deferred promise in the catch block
      // below cannot become an unhandled rejection and terminate the daemon.
      // The awaited path still observes the original rejection normally.
      void incomingTrack.catch(() => undefined)
      try {
        const offer = await this.restClient.subscribeTrack(
          this.mySessionId,
          participant.sessionId,
          trackName
        )
        if (this.pendingSubscription?.key === key)
          this.pendingSubscription.expectedMid = offer.mid
        await this.pc.setRemoteDescription(offer)
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        await this.restClient.renegotiate(this.mySessionId, answer)
        // Do not let the next queued negotiation overwrite the binding for
        // this one. Werift may deliver onTrack asynchronously after the SDP
        // calls resolve; waiting here keeps one pending subscription per
        // negotiation and preserves speaker attribution.
        const track = await incomingTrack
        this.bindIncomingTrack(
          {
            key,
            participantId: participant.participantId,
            participantName: participant.name,
            trackName,
          },
          track
        )
      } catch (error) {
        if (this.pendingSubscription?.key === key) {
          this.pendingSubscription.reject(
            error instanceof Error
              ? error
              : new Error("track_subscription_failed")
          )
          this.pendingSubscription = null
        }
        this.subscriptions.delete(key)
        throw error
      }
    })
    this.negotiationQueue = run.catch(() => undefined)
    return run
  }

  private handleIncomingTrack(track: MediaTrackLike): void {
    if (track.kind !== "audio") return
    const pending = this.pendingSubscription
    if (!pending) return
    // Werift may surface an already-negotiated track before the newly added
    // m-line during renegotiation. Never attach that callback to the current
    // participant just because it arrived first; use the negotiated mid.
    if (pending.expectedMid && track.mid !== pending.expectedMid) return
    this.pendingSubscription = null
    pending.resolve(track)
  }

  private bindIncomingTrack(
    pending: Omit<
      NonNullable<SfuMediaBridge["pendingSubscription"]>,
      "resolve" | "reject"
    >,
    track: MediaTrackLike
  ): void {
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
      this.emitAudioFrame(pending, track, packet)
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

  private emitAudioFrame(
    pending: AudioSource,
    track: MediaTrackLike,
    packet: RtpPacketLike
  ): void {
    const handler = this.onAudioFrame
    if (!handler) return
    const codec = track.codec
    if (!codec || !Number.isFinite(codec.clockRate) || codec.clockRate <= 0)
      return
    const mimeType = codec.mimeType.toLowerCase()
    const normalizedCodec =
      mimeType === "audio/opus"
        ? "opus"
        : mimeType === "audio/pcm_s16le"
          ? "pcm_s16le"
          : undefined
    if (!normalizedCodec || !codec.channels || codec.channels < 1) return
    const frame = {
      codec: normalizedCodec,
      sampleRateHz: codec.clockRate,
      channels: codec.channels,
      timestampMs: (packet.header.timestamp / codec.clockRate) * 1000,
      // Buffer.prototype.slice() is a view, not a copy. Constructing a new
      // Uint8Array keeps a speech consumer from observing a reused werift
      // packet buffer.
      data: new Uint8Array(packet.payload),
    } as const
    try {
      handler(
        {
          participantId: pending.participantId,
          participantName: pending.participantName,
          trackName: pending.trackName,
        },
        frame
      )
    } catch {
      // A future speech consumer is additive. Its failure must not interrupt
      // diagnostics or the subscribe-only media bridge.
    }
  }
}
