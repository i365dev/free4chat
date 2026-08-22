import type { PeerConnectionFactory } from "./peerConnectionLike.js"
import type { DecodedParticipantHandle } from "./participantHandle.js"
import { SfuMediaBridge } from "./sfuMediaBridge.js"
import type { SfuRestClientLike } from "./sfuRestClient.js"
import type { MediaBridgeEventHandler } from "./types.js"
import type { Free4ChatClient } from "../types.js"

const DEFAULT_POLL_INTERVAL_MS = 5000

export interface MeetingNotesControllerOptions {
  client: Free4ChatClient
  roomId: string
  participantId: string
  mcpUrl: string
  handle: DecodedParticipantHandle
  onEvent: MediaBridgeEventHandler
  pollIntervalMs?: number
  /** Injectable for tests. */
  createBridge?: (handle: DecodedParticipantHandle) => SfuMediaBridge
  createPeerConnection?: PeerConnectionFactory
  restClient?: SfuRestClientLike
  log?: (event: string, details?: Record<string, string | number>) => void
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
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private bridge: SfuMediaBridge | null = null
  private bridgeRunning = false
  private stopped = true
  private readonly log: (
    event: string,
    details?: Record<string, string | number>
  ) => void

  constructor(private readonly options: MeetingNotesControllerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.log = options.log ?? (() => undefined)
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
    await this.stopBridge()
  }

  /** Exposed for tests; also called internally on the poll timer. */
  async poll(): Promise<void> {
    if (this.stopped) return
    let authorized = false
    try {
      const info = await this.options.client.roomInfo(this.options.roomId)
      authorized =
        info.meetingNotes.active &&
        info.meetingNotes.agentParticipantId === this.options.participantId
    } catch {
      // A transient room_info failure fails closed: do not keep an
      // already-running bridge alive on stale authorization, and do not
      // start a new one on a guess. The next poll tries again.
      authorized = false
    }
    if (this.stopped) return
    if (authorized) await this.startBridgeIfNeeded()
    else await this.stopBridge()
  }

  private async startBridgeIfNeeded(): Promise<void> {
    if (this.bridgeRunning) return // already running — no duplicate bridge
    const bridge =
      this.options.createBridge?.(this.options.handle) ??
      new SfuMediaBridge({
        mcpUrl: this.options.mcpUrl,
        handle: this.options.handle,
        onEvent: this.options.onEvent,
        createPeerConnection: this.options.createPeerConnection,
        restClient: this.options.restClient,
      })
    this.bridge = bridge
    try {
      await bridge.start()
      this.bridgeRunning = true
      this.log("meeting_notes_media_started")
    } catch (error) {
      // A failed MediaBridge start must never break text Agent operation —
      // log and let the next poll retry; SfuMediaBridge.start() itself is
      // transactional, so `bridge` is already back in a clean, retryable
      // state and safe to call start() on again next poll.
      this.bridge = null
      this.bridgeRunning = false
      this.log("meeting_notes_media_start_failed", {
        error: error instanceof Error ? error.message : "unknown error",
      })
    }
  }

  private async stopBridge(): Promise<void> {
    if (!this.bridgeRunning || !this.bridge) return
    this.bridge.stop()
    this.bridge = null
    this.bridgeRunning = false
    this.log("meeting_notes_media_stopped")
  }
}
