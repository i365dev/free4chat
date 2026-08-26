import { appendFileSync } from "node:fs"
import { Free4ChatClientError } from "../free4chat/client.js"
import { MeetingNotesController } from "../media/meetingNotesController.js"
import { decodeParticipantHandle } from "../media/participantHandle.js"
import type {
  AudioFrameHandler,
  MediaBridgeEventHandler,
} from "../media/types.js"
import {
  createConfiguredSpeechTranscriber,
  type SpeechRuntimeOptions,
} from "../speech/runtime.js"
import type { SpeechTranscriber } from "../speech/transcriber.js"
import {
  MeetingTranscriptStore,
  recordCommittedTranscriptEvent,
} from "../speech/transcript.js"
import { EventBuffer, boundedPush } from "./eventBuffer.js"
import type {
  AttachmentUpload,
  CollabRequestArgs,
  CollabResultArgs,
  CreateRoomResult,
  Free4ChatClient,
  HarnessAdapter,
  HarnessEvent,
  HarnessTurnInput,
  JoinResult,
  ParticipantRosterEntry,
  RoomEvent,
  RoomSurfaceMetadataV1,
  SurfacePublishPayload,
  SurfaceReadResult,
  UploadedAttachment,
} from "../types.js"
import type { VoiceOutput } from "../voice/speaker.js"

const WAIT_SECONDS = 20
const MAX_PENDING_TURNS = 8
const MAX_IMAGES_PER_TURN = 2
const MAX_TEXT_FILE_CHARS = 32_000

// Pure attachment-enrichment pass shared by the runtime turn pipeline.
// Text-like attachments become bounded inline `textFile` content; binary
// image attachments become `image` blocks; per-event failures are reported
// and never abort the turn — attachments stay fail-open (#82).
export async function enrichTurnAttachments(
  input: HarnessTurnInput,
  participantHandle: string,
  readAttachment: (
    attachmentId: string
  ) => Promise<{ data: string; mimeType: string; text?: string }>,
  onUnavailable?: (event: HarnessEvent, message: string) => void,
  options?: { imagesSupported?: boolean }
): Promise<HarnessTurnInput> {
  const imagesSupported = options?.imagesSupported ?? true
  let imageCount = 0
  for (const event of input.events) {
    if (!event.attachment) continue
    try {
      const attachment = await readAttachment(event.attachment.id)
      if (typeof attachment.text === "string") {
        event.textFile = {
          fileName: event.attachment.fileName,
          mimeType: attachment.mimeType,
          content: attachment.text.slice(0, MAX_TEXT_FILE_CHARS),
        }
        continue
      }
      if (!imagesSupported || imageCount >= MAX_IMAGES_PER_TURN) continue
      event.image = {
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
      }
      imageCount += 1
    } catch (error) {
      onUnavailable?.(event, error instanceof Error ? error.message : "unknown")
    }
  }
  return input
}

export interface RuntimeStatus {
  instanceId: string
  /** Absent only in the create-first lifecycle before the room is created. */
  roomId?: string
  name: string
  adapter: string
  state: "starting" | "waiting" | "turn" | "reconnecting" | "stopped" | "failed"
  participantId?: string
  lastError?: string
}

export interface ResidentRuntimeOptions {
  instanceId: string
  /** Known upfront for join lifecycles. Omitted for the create-first
   * lifecycle (#51): startByCreate resolves it from the create result. */
  roomId?: string
  name: string
  client: Free4ChatClient
  adapter: HarnessAdapter
  /** Capability tokens this agent advertises for the room (#106 Phase A).
   * Chosen by the operator/Harness at join time; re-advertised verbatim on
   * every (re)join so presence metadata survives reconnects. */
  capabilities?: string[]
  log?: (event: string, details?: Record<string, string | number>) => void
  /** Same MCP endpoint `client` was built with — needed to derive the site
   * origin for the Meeting Notes media REST surface. */
  mcpUrl: string
  onMediaEvent?: MediaBridgeEventHandler
  speech?: SpeechRuntimeOptions
  /** Per-instance temporary transcript path, owned and cleaned by Runtime. */
  transcriptPath?: string
  /** Injectable for proving transcript failure cannot break text turns. */
  transcriptStore?: MeetingTranscriptStore
  /** Called after a natural room expiry has released Runtime resources. */
  onRoomExpired?: () => Promise<void> | void
  /** Outbound voice capability (#83 vertical slice): when provided, each
   * Harness response is spoken through it after the text message is sent,
   * and a new addressed turn cancels stale speech first. Return null to
   * run a text-only Agent; a throwing factory degrades to null. */
  createVoiceOutput?: () => VoiceOutput | null
  /** Injectable for tests. */
  createMeetingNotesController?: (
    handle: ReturnType<typeof decodeParticipantHandle>
  ) => MeetingNotesController
}

function defaultLog(
  event: string,
  details?: Record<string, string | number>
): void {
  if (details) console.error(`[free4chat-agent] ${event}`, details)
  else console.error(`[free4chat-agent] ${event}`)
}

// Voice is strictly additive (#83): a broken factory must degrade to a
// text-only Agent instead of failing construction.
function createVoiceOutputSafely(
  options: ResidentRuntimeOptions,
  log: (event: string, details?: Record<string, string | number>) => void
): VoiceOutput | null {
  if (!options.createVoiceOutput) return null
  try {
    return options.createVoiceOutput()
  } catch (error) {
    log("voice_output_init_failed", {
      error: error instanceof Error ? error.message : "unknown error",
    })
    return null
  }
}

export function buildHarnessTurn(
  events: RoomEvent[],
  meetingTranscript?: HarnessTurnInput["meetingTranscript"],
  context?: {
    self?: HarnessTurnInput["room"]["self"]
    participants?: ParticipantRosterEntry[]
  }
): HarnessTurnInput {
  return {
    room: {
      ephemeral: true,
      ...(context?.self ? { self: context.self } : {}),
      ...(context?.participants && context.participants.length > 0
        ? { participants: context.participants }
        : {}),
    },
    events: events.map((event) => {
      const normalized: HarnessEvent = {
        sender: event.participant.name,
        kind: event.participant.kind,
        text: event.text,
        actionType: event.actionType,
        actionPayload: event.actionPayload,
        addressed: event.addressed,
        attachment: event.attachment,
        ...(event.collab
          ? {
              collab: {
                ...event.collab,
                fromName: event.participant.name,
              },
            }
          : {}),
        ...(event.textFile ? { textFile: event.textFile } : {}),
        sequence: event.sequence,
        createdAt: event.createdAt,
      }
      return normalized
    }),
    ...(meetingTranscript ? { meetingTranscript } : {}),
  }
}

export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000)
}

export class ResidentRoomRuntime {
  private participantHandle?: string
  private participantId?: string
  private cursor = 0
  private expiresAt?: number
  private state: RuntimeStatus["state"] = "starting"
  private lastError?: string
  private stopped = false
  private loopPromise?: Promise<void>
  private turnRunning = false
  private harnessFailed = false
  private lastHarnessSequence = 0
  private readonly pendingAddressed: number[] = []
  private readonly eventBuffer = new EventBuffer()
  // Current advertised capability list. Starts from the configured options
  // and is replaced in place by updateCapabilities() so a rejoin always
  // re-advertises the latest list, never a stale one.
  private advertisedCapabilities: string[]
  // Latest compact roster seen from wait_for_events responses; injected into
  // every Harness turn so peers and their advertised capabilities are
  // visible without any extra polling.
  private roster: ParticipantRosterEntry[] = []
  // Room id for the current lifecycle: set at construction for joins, or by
  // startByCreate from the create result. Empty until adopted in the
  // create-first lifecycle.
  private resolvedRoomId?: string

  private get activeRoomId(): string {
    return this.resolvedRoomId ?? this.options.roomId ?? ""
  }
  private readonly log: (
    event: string,
    details?: Record<string, string | number>
  ) => void
  private meetingNotes: MeetingNotesController | null = null
  private transcriber: SpeechTranscriber | null = null
  private readonly voiceOutput: VoiceOutput | null
  private readonly transcript?: MeetingTranscriptStore
  private cleanupPromise?: Promise<void>
  private roomExpiryHandled = false

  constructor(private readonly options: ResidentRuntimeOptions) {
    this.advertisedCapabilities = [...(options.capabilities ?? [])]
    this.transcript =
      options.transcriptStore ??
      (options.transcriptPath
        ? new MeetingTranscriptStore(options.transcriptPath)
        : undefined)
    this.log = options.log ?? defaultLog
    this.voiceOutput = createVoiceOutputSafely(options, this.log)
    options.adapter.onFailure?.((error) => {
      if (this.stopped) return
      this.harnessFailed = true
      this.state = "reconnecting"
      this.lastError = error.message
      this.log("harness_failed")
    })
  }

  getStatus(): RuntimeStatus {
    return {
      instanceId: this.options.instanceId,
      ...(this.activeRoomId ? { roomId: this.activeRoomId } : {}),
      name: this.options.name,
      adapter: this.options.adapter.name,
      state: this.state,
      participantId: this.participantId,
      lastError: this.lastError,
    }
  }

  async start(): Promise<void> {
    await this.prepareLifecycle()
    await this.join()
    this.loopPromise = this.waitLoop()
  }

  /** Create-first lifecycle (#51): connects the Harness first (a Harness
   * failure must never orphan a created room), then atomically creates a
   * fresh room registering this agent as participant #1, adopts the create
   * result exactly like a normal join — the wait loop starts from the
   * create cursor and joinRoom is never called for this room until a later
   * lease-expiry reconnect, which always uses the normal join path and can
   * never re-create. Returns the public invite descriptor; the private
   * handle/token never leaves this object. */
  async startByCreate(): Promise<CreateRoomResult> {
    await this.prepareLifecycle()
    const created = await this.options.client.createRoom(
      this.options.name,
      this.advertisedCapabilities.length > 0
        ? this.advertisedCapabilities
        : undefined
    )
    this.resolvedRoomId = created.invite.roomId
    this.adoptJoin(created)
    // Identical adoption semantics to join(): the Meeting Notes controller
    // must exist for THIS participant from the start, so a Human joining via
    // the invite and granting Meeting Notes is picked up immediately — not
    // only after some later lease-expiry rejoin.
    await this.restartMeetingNotesController()
    this.loopPromise = this.waitLoop()
    return created
  }

  /** Shared pre-flight: transcript init, MCP connection, Harness session.
   * Ordering matters — the Harness session exists before any room is
   * joined or created, so local readiness failures happen before room
   * admission. */
  private async prepareLifecycle(): Promise<void> {
    try {
      await this.transcript?.ready()
    } catch {
      // Transcript persistence is optional. A filesystem failure here must
      // never prevent the text Agent from joining the room.
      this.log("meeting_transcript_init_failed")
    }
    await this.options.client.connect()
    await this.options.adapter.ensureSession()
  }

  /** Single adoption path for any successful room acquisition (join or
   * create): resets cursor/event state from the returned capability and
   * rebuilds the Meeting Notes controller against the fresh participant. */
  private adoptJoin(joined: JoinResult): void {
    // The capability is intentionally kept only in this object and is never
    // included in HarnessTurnInput, RuntimeStatus, or log details.
    this.participantHandle = joined.participantHandle
    this.participantId = joined.participantId
    this.cursor = joined.cursor
    this.lastHarnessSequence = joined.cursor
    this.expiresAt = joined.expiresAt
    this.eventBuffer.clear()
    this.pendingAddressed.length = 0
    this.state = "waiting"
    this.lastError = undefined
  }

  private async join(): Promise<void> {
    const joined = await this.options.client.joinRoom(
      this.activeRoomId,
      this.options.name,
      this.advertisedCapabilities.length > 0
        ? this.advertisedCapabilities
        : undefined
    )
    this.adoptJoin(joined)
    await this.restartMeetingNotesController()
  }

  // Called once per (re)join, since a rejoin gets a fresh
  // participantHandle/participantId — the previous controller's grant
  // check (matching the *old* participantId) would never authorize again
  // even if the room still names this Agent, so it must be replaced, not
  // reused. A failure constructing/starting this must never fail join()
  // itself — Meeting Notes media is strictly additive to text/ACP.
  /** Called when a Meeting Notes grant actually activates (#105): inspects
   * real speech readiness and, only when a credential is the missing piece,
   * tells the room once — pointing at the agent's local session for the key
   * itself, never soliciting secrets in room chat. */
  private async notifySpeechPrerequisite(): Promise<void> {
    try {
      const speech = this.options.speech ?? {}
      const { LocalSpeechStore } = await import("../speech/storage.js")
      const { productionSpeechRegistry } = await import("../speech/registry.js")
      const { resolveSpeechProviderState, hasRequiredValues } =
        await import("../speech/providerState.js")
      const store = speech.store ?? new LocalSpeechStore()
      const registry = speech.registry ?? productionSpeechRegistry()
      const environment = speech.environment ?? process.env
      const state = await resolveSpeechProviderState(
        registry,
        store,
        environment
      )
      const notice = buildSpeechNotice({
        providerId: state.providerId ?? null,
        hasProvider: state.provider !== undefined,
        valuesComplete:
          state.provider !== undefined &&
          hasRequiredValues(state.provider, state.values),
      })
      if (!notice) return
      if (!this.participantHandle) return
      await this.options.client
        .sendText(this.participantHandle, notice)
        .catch(() => undefined)
    } catch {
      // The notice is best-effort; readiness stays authoritative.
    }
  }

  /** Builds the configured speech transcriber with transcript wiring.
   * Shared by controller restarts and the #105 credential hot-reload path. */
  private async createTranscriber(): Promise<SpeechTranscriber | null> {
    return createConfiguredSpeechTranscriber({
      ...(this.options.speech ?? {}),
      onEvent: (event) => {
        if (this.transcript)
          recordCommittedTranscriptEvent(this.transcript, event)
        this.options.speech?.onEvent?.(event)
      },
    })
  }

  /** Reloads speech configuration without touching the room participant
   * (#105): closes any existing transcriber, then re-reads local speech
   * storage so a just-completed credential setup is picked up by the
   * resident instance while lease/room presence stay intact. If the rebuild
   * itself fails, the transcriber stays absent until setup succeeds again —
   * readiness remains the source of truth for the calling agent. */
  async reloadSpeech(): Promise<boolean> {
    const previous = this.transcriber
    this.transcriber = null
    if (previous) await previous.close().catch(() => undefined)
    try {
      this.transcriber = await this.createTranscriber()
      return this.transcriber !== null
    } catch {
      this.transcriber = null
      return false
    }
  }

  private async restartMeetingNotesController(): Promise<void> {
    const previous = this.meetingNotes
    this.meetingNotes = null
    if (previous) await previous.stop().catch(() => undefined)
    const previousTranscriber = this.transcriber
    this.transcriber = null
    if (previousTranscriber)
      await previousTranscriber.close().catch(() => undefined)
    if (!this.participantHandle || !this.participantId) return
    try {
      const handle = decodeParticipantHandle(this.participantHandle)
      this.transcriber = await this.createTranscriber()
      const onMediaEvent: MediaBridgeEventHandler = (event) => {
        this.transcriber?.handleMediaEvent(event)
        this.options.onMediaEvent?.(event)
      }
      const onAudioFrame: AudioFrameHandler = (source, frame) => {
        this.transcriber?.acceptAudio(source, frame)
      }
      const controller =
        this.options.createMeetingNotesController?.(handle) ??
        new MeetingNotesController({
          client: this.options.client,
          roomId: this.activeRoomId,
          participantId: this.participantId,
          mcpUrl: this.options.mcpUrl,
          handle,
          onEvent: onMediaEvent,
          onAudioFrame,
          onGrantActivated: () => void this.notifySpeechPrerequisite(),
          log: this.log,
          voiceReply: {
            createTtsProvider: async () => {
              const { resolveConfiguredTtsProvider } =
                await import("../voice/ttsProvider.js")
              const state = await resolveConfiguredTtsProvider({
                registry:
                  this.options.speech?.registry ??
                  (
                    await import("../speech/registry.js")
                  ).productionSpeechRegistry(),
                store:
                  (this.options.speech?.store ??
                  (await import("../speech/storage.js")).LocalSpeechStore)
                    ? (this.options.speech?.store ??
                      new (
                        await import("../speech/storage.js")
                      ).LocalSpeechStore())
                    : this.options.speech!.store!,
                environment: this.options.speech?.environment ?? process.env,
              })
              return state.tts ?? null
            },
          },
        })
      this.meetingNotes = controller
      void controller.start()
    } catch (error) {
      this.log("meeting_notes_controller_init_failed", {
        error: error instanceof Error ? error.message : "unknown error",
      })
    }
  }

  private async waitLoop(): Promise<void> {
    let retryAttempt = 0
    while (!this.stopped && this.participantHandle) {
      try {
        const result = await this.options.client.waitForEvents(
          this.participantHandle,
          this.cursor,
          WAIT_SECONDS
        )
        retryAttempt = 0
        this.cursor = Math.max(this.cursor, result.cursor)
        this.expiresAt = result.expiresAt
        if (result.participants) this.roster = result.participants
        for (const event of result.events) this.acceptEvent(event)
        if (this.pendingAddressed.length > 0) void this.drainTurns()
      } catch (error) {
        const code =
          error instanceof Free4ChatClientError ? error.code : "transient"
        if (code === "invalid_participant_handle") {
          const rejoined = await this.rejoinAfterExpiry()
          if (!rejoined) break
          continue
        }
        if (code === "room_expired") {
          await this.cleanupAfterRoomExpiry()
          break
        }
        retryAttempt += 1
        this.state = "reconnecting"
        this.lastError =
          error instanceof Error ? error.message : "network error"
        this.log("wait_retry", { delayMs: retryDelay(retryAttempt) })
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelay(retryAttempt))
        )
        if (!this.stopped)
          this.state = this.harnessFailed
            ? "reconnecting"
            : this.turnRunning
              ? "turn"
              : "waiting"
      }
    }
  }

  private acceptEvent(event: RoomEvent): void {
    this.eventBuffer.add(event)
    if (event.addressed)
      boundedPush(this.pendingAddressed, event.sequence, MAX_PENDING_TURNS)
  }

  private async drainTurns(): Promise<void> {
    if (this.turnRunning || this.stopped) return
    this.turnRunning = true
    try {
      while (!this.stopped && this.pendingAddressed.length > 0) {
        const through = this.pendingAddressed.shift()!
        const events = this.eventBuffer.since(this.lastHarnessSequence, through)
        if (events.length === 0) continue
        this.lastHarnessSequence = Math.max(
          this.lastHarnessSequence,
          ...events.map((event) => event.sequence)
        )
        try {
          await this.transcript?.flush()
        } catch {
          // Transcript persistence is optional and must never gate a normal
          // text turn. The in-memory snapshot remains available below.
          this.log("meeting_transcript_write_failed")
        }
        const input = await this.resolveImages(
          buildHarnessTurn(events, this.transcript?.snapshot(), {
            self: {
              instanceId: this.options.instanceId,
              ...(this.participantId
                ? { participantId: this.participantId }
                : {}),
              name: this.options.name,
              ...(this.advertisedCapabilities.length > 0
                ? { capabilities: this.advertisedCapabilities }
                : {}),
            },
            participants: this.roster,
          })
        )
        this.state = "turn"
        // A newly addressed turn wins the speaker (#83): stale audio from
        // the previous response must never keep playing over the new one.
        const voiceOutput = this.resolveVoiceOutput()
        voiceOutput?.cancel()
        const result = await this.options.adapter.runTurn(input)
        this.harnessFailed = false
        const text = result.text?.trim()
        if (text && this.participantHandle) {
          const sent = await this.options.client.sendText(
            this.participantHandle,
            text
          )
          this.log("message_persisted", { sequence: sent.sequence })
          voiceOutput?.speak(text)
        }
      }
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Harness turn failed"
      this.log("turn_failed")
    } finally {
      this.turnRunning = false
      if (!this.stopped)
        this.state = this.harnessFailed ? "reconnecting" : "waiting"
    }
  }

  private async resolveImages(
    input: HarnessTurnInput
  ): Promise<HarnessTurnInput> {
    if (!this.participantHandle) return input
    // Text attachments serve every Harness; only image blocks depend on the
    // negotiated image capability (#90 review follow-up).
    const imagesSupported = this.options.adapter.capabilities?.images !== false
    const handle = this.participantHandle
    return enrichTurnAttachments(
      input,
      handle,
      (attachmentId) =>
        this.options.client.readAttachment(handle, attachmentId),
      (event, message) => {
        this.log("attachment_unavailable", {
          attachmentId: event.attachment?.id ?? "unknown",
          error: message,
        })
        if (process.env.FREE4CHAT_MCP_DEBUG === "1") {
          try {
            appendFileSync(
              "/tmp/free4chat-pion/attachment-errors.log",
              `${new Date().toISOString()} ${event.attachment?.id} ${message}\n`
            )
          } catch {
            // Diagnostics only.
          }
        }
      },
      { imagesSupported }
    )
  }

  private async rejoinAfterExpiry(): Promise<boolean> {
    if (this.stopped) return false
    this.state = "reconnecting"
    this.log("participant_rejoin")
    this.participantHandle = undefined
    this.participantId = undefined
    let attempt = 0
    while (!this.stopped && !this.participantHandle) {
      try {
        await this.join()
        return true
      } catch (error) {
        const code =
          error instanceof Free4ChatClientError ? error.code : "transient"
        if (code === "room_expired") {
          await this.cleanupAfterRoomExpiry()
          return false
        }
        attempt += 1
        this.lastError =
          error instanceof Error ? error.message : "Unable to rejoin room"
        this.log("rejoin_retry", { delayMs: retryDelay(attempt) })
        await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)))
      }
    }
    return false
  }

  /** Replaces the advertised capability list in place (#106 Phase A): the
   * room record is updated immediately and every future (re)join re-uses
   * this list, so the advertisement survives lease-expiry rejoins. */
  async updateCapabilities(capabilities: string[]): Promise<void> {
    if (!this.participantHandle)
      throw new Error("Runtime is not connected to a room")
    await this.options.client.updateCapabilities(
      this.participantHandle,
      capabilities
    )
    this.advertisedCapabilities = [...capabilities]
  }

  currentCapabilities(): string[] {
    return [...this.advertisedCapabilities]
  }

  private requireHandle(): string {
    if (!this.participantHandle)
      throw new Error("Runtime is not connected to a room")
    return this.participantHandle
  }

  async collabRequest(
    args: CollabRequestArgs
  ): Promise<{ requestId: string; sequence: number; duplicate?: boolean }> {
    return this.options.client.sendCollabRequest(this.requireHandle(), args)
  }

  async collabResponse(
    requestId: string,
    decision: "accepted" | "declined",
    summary?: string
  ): Promise<{ sequence: number }> {
    return this.options.client.sendCollabResponse(
      this.requireHandle(),
      requestId,
      decision,
      summary
    )
  }

  async collabResult(args: CollabResultArgs): Promise<{ sequence: number }> {
    return this.options.client.sendCollabResult(this.requireHandle(), args)
  }

  /** Uploads an artifact into the room's ephemeral attachment store and
   * returns its metadata — the attachment id is what a collaboration result
   * references via --attach, so it must reach the caller. */
  async uploadAttachment(file: AttachmentUpload): Promise<UploadedAttachment> {
    return this.options.client.uploadAttachment(this.requireHandle(), file)
  }

  // #111 Observable Agent Workspace: thin passthroughs. The participant
  // handle stays inside the runtime; no capture scheduling exists here.
  publishSurface(payload: SurfacePublishPayload): Promise<{
    surface: RoomSurfaceMetadataV1
  }> {
    return this.options.client.publishSurface(this.requireHandle(), payload)
  }

  clearSurface(): Promise<void> {
    return this.options.client.clearSurface(this.requireHandle())
  }

  readSurface(
    sourceParticipantId: string,
    snapshotId: string
  ): Promise<SurfaceReadResult> {
    return this.options.client.readSurface(
      this.requireHandle(),
      sourceParticipantId,
      snapshotId
    )
  }

  /** Current sanitized metadata for a peer, used by CLI `surface read` to
   * pin the exact snapshotId before any bytes move. */
  peerSurface(sourceParticipantId: string): RoomSurfaceMetadataV1 | null {
    const entry = this.roster.find((p) => p.id === sourceParticipantId)
    return entry?.surface ?? null
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.state = "stopped"
    await this.cleanupResources()
    await this.loopPromise
  }

  private async cleanupAfterRoomExpiry(): Promise<void> {
    if (this.roomExpiryHandled) return
    this.roomExpiryHandled = true
    this.stopped = true
    this.state = "stopped"
    this.lastError = "room_expired"
    await this.cleanupResources()
    try {
      await this.options.onRoomExpired?.()
    } catch {
      this.log("room_expiry_cleanup_failed")
    }
  }

  // #83: injected test hook takes precedence; production resolves through
  // the shared Meeting Notes bridge only while a voiceReply grant is live.
  private resolveVoiceOutput(): VoiceOutput | null {
    if (this.options.createVoiceOutput) return this.options.createVoiceOutput()
    return this.meetingNotes?.currentVoiceOutput() ?? null
  }

  private async cleanupResources(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    this.cleanupPromise = (async () => {
      if (this.meetingNotes) {
        await this.meetingNotes.stop().catch(() => undefined)
        this.meetingNotes = null
      }
      if (this.transcriber) {
        await this.transcriber.close().catch(() => undefined)
        this.transcriber = null
      }
      if (this.voiceOutput) {
        await this.voiceOutput.close().catch(() => undefined)
      }
      await this.transcript?.dispose()
      try {
        await this.options.adapter.cancelTurn?.()
      } catch {
        // Closing the ACP process below is the final cancellation boundary.
      }
      if (this.participantHandle) {
        try {
          await this.options.client.leaveRoom(this.participantHandle)
        } catch {
          // Expiry and network loss are already a clean enough termination.
        }
      }
      await this.options.adapter.close()
      await this.options.client.close()
    })()
    return this.cleanupPromise
  }
}

/** Pure classifier for the #105 speech-prerequisite room notice.
 * Returns null when there is nothing to tell the room. */
export function buildSpeechNotice(state: {
  providerId: string | null
  hasProvider: boolean
  valuesComplete: boolean
}): string | null {
  if (!state.hasProvider)
    return "Meeting Notes was requested, but no speech-to-text provider is configured in my local runtime. I'll complete speech setup in my own session before transcribing — please don't paste API keys into this room."
  if (!state.valuesComplete)
    return "Meeting Notes was requested, but my local speech-to-text is missing its API key. I'll complete setup in my own session — please don't paste API keys into this room."
  return null
}
