import { Free4ChatClientError } from "../free4chat/client.js"
import { EventBuffer, boundedPush } from "./eventBuffer.js"
import type {
  Free4ChatClient,
  HarnessAdapter,
  HarnessEvent,
  HarnessTurnInput,
  RoomEvent,
} from "../types.js"

const WAIT_SECONDS = 20
const MAX_PENDING_TURNS = 8
const MAX_IMAGES_PER_TURN = 2

export interface RuntimeStatus {
  instanceId: string
  roomId: string
  name: string
  adapter: string
  state: "starting" | "waiting" | "turn" | "reconnecting" | "stopped" | "failed"
  participantId?: string
  lastError?: string
}

export interface ResidentRuntimeOptions {
  instanceId: string
  roomId: string
  name: string
  client: Free4ChatClient
  adapter: HarnessAdapter
  log?: (event: string, details?: Record<string, string | number>) => void
}

function defaultLog(
  event: string,
  details?: Record<string, string | number>
): void {
  if (details) console.error(`[free4chat-agent] ${event}`, details)
  else console.error(`[free4chat-agent] ${event}`)
}

export function buildHarnessTurn(events: RoomEvent[]): HarnessTurnInput {
  return {
    room: { ephemeral: true },
    events: events.map((event) => {
      const normalized: HarnessEvent = {
        sender: event.participant.name,
        kind: event.participant.kind,
        text: event.text,
        actionType: event.actionType,
        actionPayload: event.actionPayload,
        addressed: event.addressed,
        attachment: event.attachment,
        sequence: event.sequence,
        createdAt: event.createdAt,
      }
      return normalized
    }),
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
  private readonly log: (
    event: string,
    details?: Record<string, string | number>
  ) => void

  constructor(private readonly options: ResidentRuntimeOptions) {
    this.log = options.log ?? defaultLog
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
      roomId: this.options.roomId,
      name: this.options.name,
      adapter: this.options.adapter.name,
      state: this.state,
      participantId: this.participantId,
      lastError: this.lastError,
    }
  }

  async start(): Promise<void> {
    await this.options.client.connect()
    await this.options.adapter.ensureSession()
    await this.join()
    this.loopPromise = this.waitLoop()
  }

  private async join(): Promise<void> {
    const joined = await this.options.client.joinRoom(
      this.options.roomId,
      this.options.name
    )
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
          this.state = "stopped"
          this.lastError = "room_expired"
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
        const input = await this.resolveImages(buildHarnessTurn(events))
        this.state = "turn"
        const result = await this.options.adapter.runTurn(input)
        this.harnessFailed = false
        const text = result.text?.trim()
        if (text && this.participantHandle) {
          const sent = await this.options.client.sendText(
            this.participantHandle,
            text
          )
          this.log("message_persisted", { sequence: sent.sequence })
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
    if (this.options.adapter.capabilities?.images === false) return input
    let imageCount = 0
    for (const event of input.events) {
      if (!event.attachment || imageCount >= MAX_IMAGES_PER_TURN) continue
      try {
        const image = await this.options.client.readAttachment(
          this.participantHandle,
          event.attachment.id
        )
        event.image = {
          type: "image",
          data: image.data,
          mimeType: image.mimeType,
        }
        imageCount += 1
      } catch {
        this.log("attachment_unavailable")
      }
    }
    return input
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
          this.state = "stopped"
          this.lastError = "room_expired"
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

  async stop(): Promise<void> {
    this.stopped = true
    this.state = "stopped"
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
    await this.loopPromise
  }
}
