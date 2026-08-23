import type {
  AudioFrame,
  AudioSource,
  MediaBridgeEvent,
} from "../media/types.js"
import type {
  SttError,
  SttEvent,
  SttSessionOptions,
  StreamingSttProvider,
  StreamingSttSession,
} from "./types.js"

const MAX_FRAMES_PER_TRACK = 32

export interface AttributedSttEvent {
  source: AudioSource
  event: SttEvent
}

export type AttributedSttEventHandler = (event: AttributedSttEvent) => void

export interface SpeechTranscriberOptions {
  provider: StreamingSttProvider
  onEvent?: AttributedSttEventHandler
  maxFramesPerTrack?: number
}

interface TrackState {
  key: string
  source: AudioSource
  frames: AudioFrame[]
  session?: StreamingSttSession
  pumping: boolean
  ended: boolean
  failed: boolean
  pumpPromise?: Promise<void>
}

/**
 * Runtime-owned adapter between raw SFU audio and provider sessions. Speaker
 * attribution and lifecycle live here; provider implementations only see an
 * audio frame and never a room participant.
 */
export class SpeechTranscriber {
  private readonly provider: StreamingSttProvider
  private readonly onEvent: AttributedSttEventHandler
  private readonly maxFramesPerTrack: number
  private readonly tracks = new Map<string, TrackState>()
  private stopped = false

  constructor(options: SpeechTranscriberOptions) {
    this.provider = options.provider
    this.onEvent = options.onEvent ?? (() => undefined)
    this.maxFramesPerTrack = options.maxFramesPerTrack ?? MAX_FRAMES_PER_TRACK
  }

  /** Synchronous by design: the SFU RTP callback never awaits network I/O. */
  acceptAudio(source: AudioSource, frame: AudioFrame): void {
    if (this.stopped) return
    const key = trackKey(source)
    let state = this.tracks.get(key)
    if (!state) {
      state = {
        key,
        source: { ...source },
        frames: [],
        pumping: false,
        ended: false,
        failed: false,
      }
      this.tracks.set(key, state)
    }
    if (state.ended || state.failed) return
    if (state.frames.length >= this.maxFramesPerTrack) {
      this.failTrack(state, {
        code: "audio_queue_overflow",
        message: "Speech audio queue is full",
      })
      return
    }
    // SfuMediaBridge already copies RTP payloads. Copy once more at this
    // ownership boundary so a future media implementation cannot reuse a
    // buffer while a provider is still awaiting its send.
    state.frames.push({ ...frame, data: new Uint8Array(frame.data) })
    this.schedulePump(state)
  }

  handleMediaEvent(event: MediaBridgeEvent): void {
    if (event.type === "audioTrackStarted") {
      const key = `${event.participantId}:${event.trackName}`
      const old = this.tracks.get(key)
      if (old) void this.endTrack(old)
      return
    }
    if (event.type !== "audioTrackEnded") return
    const state = this.tracks.get(`${event.participantId}:${event.trackName}`)
    if (state) void this.endTrack(state)
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const states = [...this.tracks.values()]
    this.tracks.clear()
    await Promise.all(states.map((state) => this.endTrack(state)))
    await Promise.all(
      states.map((state) => state.pumpPromise?.catch(() => undefined))
    )
  }

  private schedulePump(state: TrackState): void {
    if (state.pumping || state.ended || state.failed) return
    const promise = this.pump(state)
    state.pumpPromise = promise
    void promise.then(
      () => {
        if (state.pumpPromise === promise) state.pumpPromise = undefined
      },
      () => {
        if (state.pumpPromise === promise) state.pumpPromise = undefined
      }
    )
  }

  private async pump(state: TrackState): Promise<void> {
    if (state.pumping || state.ended || state.failed) return
    state.pumping = true
    try {
      if (!state.session) {
        const first = state.frames[0]
        if (!first) return
        const options: SttSessionOptions = {
          audio: {
            codec: first.codec === "pcm_s16le" ? "raw" : "opus",
            rate: first.sampleRateHz,
            channel: first.channels,
            ...(first.codec === "pcm_s16le" ? { bits: 16 } : {}),
          },
        }
        const createdSession = await this.provider.createSession(options)
        if (state.ended || state.failed || this.stopped) {
          await createdSession.close().catch(() => undefined)
          return
        }
        state.session = createdSession
        void this.forwardEvents(state, state.session)
      }
      while (!state.ended && !state.failed && state.frames.length > 0) {
        const frame = state.frames.shift()!
        await state.session.pushAudio(frame)
      }
    } catch (error) {
      this.failTrack(state, normalizeSpeechError(error))
    } finally {
      state.pumping = false
      if (!state.ended && !state.failed && state.frames.length > 0)
        this.schedulePump(state)
    }
  }

  private async forwardEvents(
    state: TrackState,
    session: StreamingSttSession
  ): Promise<void> {
    try {
      for await (const event of session.events()) {
        if (!state.ended) this.emit({ source: state.source, event })
      }
    } catch (error) {
      this.failTrack(state, normalizeSpeechError(error))
    }
  }

  private async endTrack(state: TrackState): Promise<void> {
    if (state.ended) return
    state.ended = true
    state.frames.length = 0
    this.tracks.delete(state.key)
    await state.session?.close().catch((error: unknown) => {
      this.emit({
        source: state.source,
        event: { type: "error", error: normalizeSpeechError(error) },
      })
    })
  }

  private failTrack(state: TrackState, error: SttError): void {
    if (state.failed || state.ended) return
    state.failed = true
    state.frames.length = 0
    this.emit({ source: state.source, event: { type: "error", error } })
    void state.session?.close().catch(() => undefined)
    this.tracks.delete(state.key)
  }

  private emit(event: AttributedSttEvent): void {
    try {
      this.onEvent(event)
    } catch {
      // Downstream observation must not tear down an audio track or its
      // provider session.
    }
  }
}

function trackKey(source: AudioSource): string {
  return `${source.participantId}:${source.trackName}`
}

function normalizeSpeechError(error: unknown): SttError {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown
      message?: unknown
      retryable?: unknown
    }
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    )
      return {
        code: candidate.code,
        message: candidate.message.slice(0, 160),
        ...(candidate.retryable === true ? { retryable: true } : {}),
      }
  }
  return { code: "speech_provider_failed", message: "Speech provider failed" }
}
