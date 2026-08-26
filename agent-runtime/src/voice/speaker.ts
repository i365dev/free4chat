import { createTextChunker, type TextChunkerOptions } from "./chunking.js"
import type {
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsAudioChunk,
} from "../speech/types.js"

/**
 * Destination for synthesized Agent audio (#83 vertical slice). Production
 * backs this with the outbound Pion/TrackLocal writer; tests inject fakes.
 * Awaiting writeAudio is the pipeline's backpressure boundary.
 *
 * The two optional methods are the utterance boundaries (#83 review): a
 * normally-completed turn must endTurn() (flush buffered tail audio) before
 * turnFinished is reported, and a cancelled turn must cancelTurn() (discard
 * any partially-buffered audio) so stale PCM can never leak into later
 * turns.
 */
export interface OutboundVoiceSink {
  writeAudio(chunk: TtsAudioChunk): Promise<void>
  /** Normal completion boundary: flush buffered tail audio. */
  endTurn?(): Promise<void>
  /** Cancelled-turn boundary: discard partial buffered audio immediately. */
  cancelTurn?(): Promise<void>
  close(): Promise<void>
}

export type VoiceSpeakerEvent =
  | { type: "turnStarted"; turn: number }
  | { type: "turnFinished"; turn: number; chunks: number; frames: number }
  | { type: "turnCancelled"; turn: number }
  | { type: "turnTruncated"; turn: number; droppedChunks: number }
  | { type: "turnFailed"; turn: number; code: string }

/** The surface ResidentRoomRuntime consumes; VoiceSpeaker satisfies it. */
export interface VoiceOutput {
  speak(text: string): void
  cancel(): void
  close(): Promise<void>
}

export interface VoiceSpeakerOptions {
  provider: StreamingTtsProvider
  /** Creates the outbound destination lazily on first audio, so a speaker
   * that never speaks never opens a track. Reused across turns; recreated
   * after a failed write (dead track) and closed by close(). */
  createSink: () => OutboundVoiceSink | Promise<OutboundVoiceSink>
  /** Upper bound on buffered text chunks before the tail is truncated. */
  maxQueuedChunks?: number
  chunkerOptions?: TextChunkerOptions
  onEvent?: (event: VoiceSpeakerEvent) => void
}

const MAX_ERROR_MESSAGE_CHARS = 160

/**
 * Runtime-owned bridge between Harness response text and one Agent's
 * outbound audio track. Guarantees, all deterministic:
 *
 * - Ordering: one consumer drains buffered chunks strictly FIFO, so audio
 *   reaches the sink exactly in text order.
 * - Backpressure: the consumer awaits every sink write before requesting
 *   more synthesis, and buffered text is bounded; an overlong response is
 *   truncated rather than accumulated without bound.
 * - Stale cancellation: speak() implicitly cancels any unfinished earlier
 *   turn (the newest addressed turn wins) and cancel() stops current and
 *   queued audio immediately; provider output from a cancelled turn never
 *   reaches the sink.
 *
 * Spoken text and audio are never persisted or logged; events carry
 * counters only.
 */
export class VoiceSpeaker implements VoiceOutput {
  private readonly provider: StreamingTtsProvider
  private readonly createSink: () =>
    OutboundVoiceSink | Promise<OutboundVoiceSink>
  private readonly maxQueuedChunks: number
  private readonly chunkerOptions: TextChunkerOptions
  private readonly onEvent: (event: VoiceSpeakerEvent) => void

  private readonly pending: string[] = []
  private epoch = 0
  private turnCounter = 0
  private lastStartedTurn: number | null = null
  private draining = false
  private stopped = false
  private sink: OutboundVoiceSink | null = null
  private sinkBroken = false
  private drainPromise: Promise<void> | null = null

  constructor(options: VoiceSpeakerOptions) {
    this.provider = options.provider
    this.createSink = options.createSink
    this.maxQueuedChunks = Math.max(1, options.maxQueuedChunks ?? 8)
    this.chunkerOptions = options.chunkerOptions ?? {}
    this.onEvent = options.onEvent ?? (() => undefined)
  }

  /** Enqueues one complete response as a new voice turn. Any unfinished
   * earlier turn is cancelled first: newest speech always wins. No-op
   * after close(). */
  speak(text: string): void {
    if (this.stopped) return
    this.cancel()
    const turn = ++this.turnCounter
    const chunker = createTextChunker(this.chunkerOptions)
    const chunks = [...chunker.push(text), ...chunker.flush()].filter(
      (chunk) => chunk.length > 0
    )
    if (chunks.length === 0) return
    if (chunks.length > this.maxQueuedChunks) {
      const dropped = chunks.length - this.maxQueuedChunks
      chunks.length = this.maxQueuedChunks
      this.onEvent({ type: "turnTruncated", turn, droppedChunks: dropped })
    }
    this.pending.push(...chunks)
    this.lastStartedTurn = turn
    this.onEvent({ type: "turnStarted", turn })
    void this.startDrain()
  }

  /** Stops current and queued audio immediately and discards any partial
   * sink carry via cancelTurn(). Safe to call repeatedly; safe when idle
   * (a no-op cancel never touches the sink). */
  cancel(): void {
    if (this.pending.length === 0 && !this.draining) return
    this.epoch += 1
    this.pending.length = 0
    // Fire the discard before anything else can write again: speak() runs
    // this synchronously and the next turn's first write can only happen
    // after an await, so over the bridge's FIFO op channel this cancel-turn
    // always lands before later audio.
    const sink = this.sink
    if (sink?.cancelTurn) void sink.cancelTurn().catch(() => undefined)
    if (this.lastStartedTurn !== null)
      this.onEvent({
        type: "turnCancelled",
        turn: this.lastStartedTurn,
      })
  }

  /** Terminal shutdown: cancels speech, waits for the pipeline to unwind,
   * and closes the outbound sink. Further speak() calls are ignored. */
  async close(): Promise<void> {
    this.stopped = true
    this.epoch += 1
    this.pending.length = 0
    await this.drainPromise?.catch(() => undefined)
    const sink = this.sink
    this.sink = null
    await sink?.close().catch(() => undefined)
  }

  // Single-flight entry: a drain bound to a cancelled epoch unwinds via its
  // own finally, which restarts for any newer turn that queued text in the
  // meantime — so speak() never has to wait for the old pipeline.
  private startDrain(): Promise<void> {
    if (this.draining) return this.drainPromise ?? Promise.resolve()
    this.draining = true
    const promise = this.drain()
    this.drainPromise = promise.finally(() => {
      this.draining = false
      this.drainPromise = null
      if (!this.stopped && this.pending.length > 0) void this.startDrain()
    })
    return this.drainPromise
  }

  private async drain(): Promise<void> {
    const myEpoch = this.epoch
    let session: StreamingTtsSession | null = null
    let chunks = 0
    let frames = 0
    try {
      while (
        !this.stopped &&
        myEpoch === this.epoch &&
        this.pending.length > 0
      ) {
        const chunk = this.pending.shift()
        if (chunk === undefined) break
        session = session ?? (await this.provider.createSession())
        if (this.stopped || myEpoch !== this.epoch) return
        for await (const audio of session.synthesize(chunk)) {
          if (this.stopped || myEpoch !== this.epoch) return
          const sink = await this.ensureSink()
          await sink.writeAudio(audio)
          frames += 1
        }
        chunks += 1
      }
      if (!this.stopped && myEpoch === this.epoch) {
        // Utterance boundary (#83 review): a normally completing turn
        // flushes the sink's buffered tail BEFORE finish is reported. A
        // flush failure is a sink failure like any other and flows to the
        // catch below (sink marked broken, turnFailed reported).
        const sink = this.sink
        if (sink && frames > 0) await sink.endTurn?.()
        this.onEvent({
          type: "turnFinished",
          turn: this.lastStartedTurn ?? 0,
          chunks,
          frames,
        })
      }
    } catch (error) {
      if (this.stopped || myEpoch !== this.epoch) return
      this.sinkBroken = true
      this.onEvent({
        type: "turnFailed",
        turn: this.lastStartedTurn ?? 0,
        code: describeError(error),
      })
    } finally {
      await session?.close().catch(() => undefined)
    }
  }

  private async ensureSink(): Promise<OutboundVoiceSink> {
    if (this.sink && !this.sinkBroken) return this.sink
    this.sink = await this.createSink()
    this.sinkBroken = false
    return this.sink
  }
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "tts synthesis failed"
  return raw.slice(0, MAX_ERROR_MESSAGE_CHARS)
}
