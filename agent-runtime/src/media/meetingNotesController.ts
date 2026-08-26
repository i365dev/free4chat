import { createWeriftPeerConnection } from "./peerConnectionLike.js"
import { ensurePionBinary } from "./pionProvision.js"
import { resolveMediaEngineName } from "./engine.js"
import { createPionPeerConnection } from "./pionPeerConnectionLike.js"
import type {
  PeerConnectionLike,
  PeerConnectionFactory,
} from "./peerConnectionLike.js"
import type { DecodedParticipantHandle } from "./participantHandle.js"
import { SfuMediaBridge } from "./sfuMediaBridge.js"
import type { SfuRestClientLike } from "./sfuRestClient.js"
import type { AudioFrameHandler, MediaBridgeEventHandler } from "./types.js"
import type { StreamingTtsProvider } from "../speech/types.js"
import { VoiceSpeaker, type VoiceOutput } from "../voice/speaker.js"
import type { Free4ChatClient } from "../types.js"

/** Default production factory (#105): lazily provisions the version-matched
 * Pion engine binary, then adapts the Go child to PeerConnectionLike.
 * werift remains available as the explicit FREE4CHAT_MEDIA_ENGINE=werift
 * developer fallback. */
export async function createPionEngineFactory(): Promise<PeerConnectionLike> {
  const resolved = await ensurePionBinary({
    binOverride: process.env.FREE4CHAT_PION_BIN,
  })
  return createPionPeerConnection({ binPath: resolved.binPath })
}

/** Resolved at construction time so tests can flip FREE4CHAT_MEDIA_ENGINE
 * before instantiating the controller. */
export function resolveDefaultCreatePeerConnection(): PeerConnectionFactory {
  return resolveMediaEngineName(process.env) === "werift"
    ? createWeriftPeerConnection
    : createPionEngineFactory
}

const DEFAULT_POLL_INTERVAL_MS = 5000

type BridgeState = "idle" | "starting" | "running"

export interface MeetingNotesControllerOptions {
  client: Free4ChatClient
  roomId: string
  participantId: string
  mcpUrl: string
  handle: DecodedParticipantHandle
  onEvent: MediaBridgeEventHandler
  onAudioFrame?: AudioFrameHandler
  /** Fired once per successful grant activation, after the media bridge is
   * running (#105): the runtime uses this to check capability
   * prerequisites (e.g. speech readiness) at the moment Meeting Notes
   * actually starts — not at join time. */
  onGrantActivated?: () => void
  pollIntervalMs?: number
  /** Injectable for tests. */
  createBridge?: (handle: DecodedParticipantHandle) => SfuMediaBridge
  createPeerConnection?: PeerConnectionFactory
  restClient?: SfuRestClientLike
  log?: (event: string, details?: Record<string, string | number>) => void
  /** #83 voiceReply: when provided, the SAME shared SfuMediaBridge also
   * publishes this agent's outbound voice whenever room_info reports an
   * active voiceReply grant for THIS participant. Harness response text is
   * spoken through the configured Doubao TTS provider; failures never
   * affect text or Meeting Notes ingress. */
  voiceReply?: {
    createTtsProvider: () => Promise<StreamingTtsProvider | null>
    pollIntervalMs?: number
  }
}

/**
 * Owns the Runtime-side half of the Meeting Notes lifecycle (#82): polls
 * room_info for the room's Meeting Notes grant and starts/stops the shared
 * SfuMediaBridge accordingly. This is the *only* thing that decides when
 * this process may hold an active SfuMediaBridge — authorization always
 * comes from the room-visible grant, never from a local decision.
 *
 * Deliberately separate from ResidentRoomRuntime's text/ACP loop: a failed
 * or stopped MediaBridge must never affect text Agent operation, so this
 * controller only ever touches its own bridge instance, never the ACP
 * adapter or the text wait loop.
 */
export class MeetingNotesController {
  private readonly pollIntervalMs: number
  private readonly createPeerConnection: PeerConnectionFactory
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private bridge: SfuMediaBridge | null = null
  private bridgeState: BridgeState = "idle"
  // Bumped on every teardown; an in-flight ensureRunning() call compares
  // its own snapshot against the current value after `bridge.start()`
  // settles to detect whether it was superseded (Stop, rejoin, or another
  // poll's unauthorized result) while it was awaiting.
  private generation = 0
  // The grant `startedAt` (epoch) the current/most-recently-started bridge
  // was built for — null when no bridge has been started yet. A room can
  // go Stop -> Start for the *same* agentParticipantId entirely between two
  // polls (this controller only samples room_info periodically, so it
  // never observes the intermediate `active: false`); comparing
  // agentParticipantId alone would then wrongly conclude "still
  // authorized, nothing to do" even though the server already closed the
  // previous grant's SFU subscriptions and this bridge's SFU session is
  // now stale. Comparing the epoch instead of just the id catches that.
  private grantEpoch: number | null = null
  private stopped = true
  // #83 voiceReply state (same shared bridge; never a second session).
  private voiceEpoch: number | null = null
  private voiceSpeaker: VoiceSpeaker | null = null
  private voiceStarting = false
  private readonly log: (
    event: string,
    details?: Record<string, string | number>
  ) => void

  constructor(private readonly options: MeetingNotesControllerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.log = options.log ?? (() => undefined)
    // Production wiring: the real, non-test ResidentRoomRuntime path never
    // passes createPeerConnection explicitly, so it must resolve to a
    // usable factory here rather than relying on every caller to remember
    // injection (see SfuMediaBridge's own throwing default, which exists
    // only to catch a *test* that forgot to inject one).
    // Production wiring: the real, non-test ResidentRoomRuntime path never
    // passes createPeerConnection explicitly, so it must resolve to a
    // usable factory here rather than relying on every caller to remember
    // injection (see SfuMediaBridge's own throwing default, which exists
    // only to catch a *test* that forgot to inject one).
    // Pion is the selected media engine after #103/#105: Meeting Notes uses
    // it by default and provisions its binary lazily on first media need.
    // FREE4CHAT_MEDIA_ENGINE=werift remains an explicit developer fallback;
    // tests may still inject createPeerConnection directly.
    this.createPeerConnection =
      options.createPeerConnection ?? resolveDefaultCreatePeerConnection()
  }

  /** Exposed for tests: proves the real production wiring resolves to the
   * actual werift-backed factory, without invoking it (no network/ICE). */
  get resolvedCreatePeerConnection(): PeerConnectionFactory {
    return this.createPeerConnection
  }

  // Mirrors SfuMediaBridge.start()'s own shape: await the initial poll
  // before arming the interval, so a caller that awaits start() sees the
  // first authorization check settle deterministically. Callers on the
  // Runtime's critical path (join()) call this without awaiting it, since
  // Meeting Notes media is an optional side capability that must never
  // block text/ACP readiness.
  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.poll()
    if (this.stopped) return
    this.pollTimer = setInterval(() => {
      void this.poll()
    }, this.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    await this.teardownBridge()
  }

  /** Exposed for tests; also called internally on the poll timer. */
  async poll(): Promise<void> {
    if (this.stopped) return
    let authorized = false
    let epoch: number | null = null
    let vrAuthorized = false
    let vrEpoch: number | null = null
    try {
      const info = await this.options.client.roomInfo(this.options.roomId)
      if (this.options.voiceReply) {
        vrAuthorized =
          info.voiceReplyMediaAvailable === true &&
          info.voiceReply.active === true &&
          info.voiceReply.agentParticipantId === this.options.participantId
        vrEpoch = info.voiceReply.startedAt ?? null
      }
      // The master switch is checked on every poll, not just at grant
      // start: if it flips off while a session is already active, this
      // cooperative Runtime must stop within one poll cycle rather than
      // keeping an already-running bridge alive just because the room
      // grant itself is still (now-meaninglessly) active. This is a
      // nice-to-have on top of the real, unconditional server-side
      // enforcement (every /tracks, /renegotiate, /tracks/close request
      // independently re-checks the grant) — not a substitute for it.
      authorized =
        info.meetingNotesMediaAvailable &&
        info.meetingNotes.active &&
        info.meetingNotes.agentParticipantId === this.options.participantId
      epoch = info.meetingNotes.startedAt ?? null
    } catch {
      // A transient room_info failure fails closed: do not keep an
      // already-running bridge alive on stale authorization, and do not
      // start a new one on a guess. The next poll tries again.
      authorized = false
    }
    if (this.stopped) return
    if (authorized) {
      if (this.bridgeState !== "idle" && epoch !== this.grantEpoch) {
        // Stop + Start for the same agent happened entirely between two
        // polls — the server already closed the previous grant's SFU
        // subscriptions, so this bridge (built for the old epoch) is stale
        // and must be torn down before a fresh one is started.
        await this.teardownBridge()
      }
      this.grantEpoch = epoch
      await this.ensureRunning()
    } else {
      this.grantEpoch = null
      await this.teardownBridge()
    }
    if (
      !this.stopped &&
      this.options.voiceReply &&
      this.bridgeState === "running"
    ) {
      if (!vrAuthorized) {
        await this.teardownVoice()
      } else {
        // Fresh activation or rotation: remember the epoch, discard any old
        // speaker, then rebuild through ensureVoice.
        if (this.voiceEpoch !== vrEpoch) {
          const old = this.voiceSpeaker
          this.voiceSpeaker = null
          this.voiceEpoch = vrEpoch
          old?.cancel()
          await old?.close().catch(() => undefined)
          await this.bridge?.deactivateVoicePublish()
        }
        if (!this.voiceSpeaker && !this.voiceStarting) await this.ensureVoice()
      }
    } else if (!vrAuthorized) await this.teardownVoice()
  }

  /** Current speakable output while a voiceReply grant is active (#83);
   * null when inactive/starting — callers stay text-only. */
  currentVoiceOutput(): VoiceOutput | null {
    return this.voiceSpeaker
  }

  private async ensureVoice(): Promise<void> {
    const options = this.options.voiceReply
    const bridge = this.bridge
    if (
      !options ||
      !bridge ||
      !bridge.voicePublishCapable ||
      this.voiceStarting ||
      this.voiceSpeaker
    )
      return
    this.voiceStarting = true
    try {
      const provider = await options.createTtsProvider()
      if (!provider || this.bridgeState !== "running") return
      await bridge.activateVoicePublish()
      if (this.bridgeState !== "running") return
      this.voiceSpeaker = new VoiceSpeaker({
        provider,
        createSink: () => ({
          writeAudio: async (chunk) => {
            if (chunk.codec !== "pcm_s16le")
              throw new Error("unsupported_chunk")
            await bridge.writeVoicePcm(chunk.data)
          },
          close: async () => {},
        }),
        chunkerOptions: { maxChars: 220 },
      })
      this.log("voice_reply_started")
    } catch (error) {
      this.log("voice_reply_start_failed", {
        error: error instanceof Error ? error.message : "unknown",
      })
    } finally {
      this.voiceStarting = false
    }
  }

  private async teardownVoice(): Promise<void> {
    if (!this.voiceSpeaker && this.voiceEpoch === null) return
    const speaker = this.voiceSpeaker
    this.voiceSpeaker = null
    this.voiceEpoch = null
    speaker?.cancel()
    await speaker?.close().catch(() => undefined)
    await this.bridge?.deactivateVoicePublish()
    this.log("voice_reply_stopped")
  }

  // Serialized start: the synchronous "already starting/running -> return"
  // check happens with no `await` before it, so two poll() calls racing
  // each other can never both pass it — only one ever proceeds to actually
  // construct and start a bridge.
  private async ensureRunning(): Promise<void> {
    if (this.bridgeState !== "idle") return // already starting or running
    this.bridgeState = "starting"
    const myGeneration = ++this.generation
    const bridge =
      this.options.createBridge?.(this.options.handle) ??
      new SfuMediaBridge({
        mcpUrl: this.options.mcpUrl,
        handle: this.options.handle,
        onEvent: this.options.onEvent,
        onAudioFrame: this.options.onAudioFrame,
        createPeerConnection: this.createPeerConnection,
        restClient: this.options.restClient,
      })
    this.bridge = bridge
    try {
      await bridge.start()
    } catch (error) {
      // A failed MediaBridge start must never break text Agent operation —
      // log and let the next poll retry; SfuMediaBridge.start() itself is
      // transactional, so `bridge` is already back in a clean, retryable
      // state. Only reset controller state if nothing superseded us while
      // we were awaiting — teardownBridge() already did so otherwise.
      if (this.generation === myGeneration) {
        this.bridge = null
        this.bridgeState = "idle"
      }
      this.log("meeting_notes_media_start_failed", {
        error: error instanceof Error ? error.message : "unknown error",
      })
      return
    }
    if (this.generation !== myGeneration) {
      // Superseded while starting (Stop, a rejoin's fresh controller, or a
      // later poll finding no authorization all bump `generation`) — this
      // bridge must never become active. teardownBridge() deliberately
      // left closing this exact instance to us: calling SfuMediaBridge.
      // stop() before its own start() has settled would race its internal
      // state, so only the attempt that owns the now-settled promise may
      // close it.
      bridge.stop()
      return
    }
    this.bridgeState = "running"
    this.log("meeting_notes_media_started")
    this.options.onGrantActivated?.()
  }

  private async teardownBridge(): Promise<void> {
    this.generation += 1 // invalidate any in-flight ensureRunning() start
    if (this.bridgeState === "idle") return
    const wasRunning = this.bridgeState === "running"
    const bridge = this.bridge
    this.bridge = null
    this.bridgeState = "idle"
    if (!wasRunning) return // still starting — see ensureRunning()'s catch-up close above
    bridge?.stop()
    this.log("meeting_notes_media_stopped")
  }
}
