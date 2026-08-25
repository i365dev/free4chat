import { randomUUID } from "node:crypto"

import type {
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsAudioChunk,
} from "../../types.js"
import { safeErrorMessage } from "../../redaction.js"
import { DoubaoProviderError } from "./provider.js"
import {
  buildDoubaoTtsHeaders,
  buildDoubaoTtsRequestBody,
  classifyTtsStreamObject,
  createStreamObjectScanner,
  DOUBAO_TTS_DEFAULT_VOICE,
  DOUBAO_TTS_ENDPOINT,
  DOUBAO_TTS_SAMPLE_RATE_HZ,
} from "./ttsProtocol.js"

const CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_CHUNK_TIMEOUT_MS = 15_000
const MAX_ERROR_MESSAGE_CHARS = 160

export interface DoubaoTtsProviderOptions {
  endpoint?: string
  /** Speaker must be a Doubao Speech Synthesis 2.0 voice: the seed-tts-2.0
   * resource only accepts 2.0 voices. */
  voice?: string
  fetchImpl?: typeof fetch
  requestIdFactory?: () => string
  uid?: string
  /** Idle gap allowed between response chunks before the request aborts. */
  chunkTimeoutMs?: number
}

/**
 * Text-to-speech against the official V3 output-unidirectional HTTP
 * interface. One credential (DOUBAO_API_KEY — the same console key family
 * as Doubao ASR) authenticates both capabilities; the TTS selection lives
 * in its own config slot. Audio is requested as raw PCM s16le / 24 kHz /
 * mono and yielded chunk by chunk in stream order. The API key exists only
 * inside the outgoing X-Api-Key header; every failure surface is redacted
 * with the key explicitly handed to the sanitizer.
 */
export class DoubaoTtsProvider implements StreamingTtsProvider {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly voice: string
  private readonly uid: string
  private readonly chunkTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly requestIdFactory: () => string

  constructor(apiKey: string, options: DoubaoTtsProviderOptions = {}) {
    this.apiKey = apiKey
    this.endpoint = options.endpoint ?? DOUBAO_TTS_ENDPOINT
    this.voice = options.voice?.trim() || DOUBAO_TTS_DEFAULT_VOICE
    this.uid = options.uid ?? "free4chat-agent"
    this.chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestIdFactory = options.requestIdFactory ?? (() => randomUUID())
  }

  async createSession(): Promise<StreamingTtsSession> {
    if (!this.apiKey)
      throw new DoubaoProviderError(
        "missing_api_key",
        "Doubao API key is required"
      )
    return new DoubaoTtsSession(this.apiKey, {
      endpoint: this.endpoint,
      voice: this.voice,
      uid: this.uid,
      chunkTimeoutMs: this.chunkTimeoutMs,
      fetchImpl: this.fetchImpl,
      requestIdFactory: this.requestIdFactory,
    })
  }

  // TypeScript private fields stay runtime-enumerable; without this guard
  // an accidental JSON.stringify of a resolved provider would emit the key.
  toJSON(): Record<string, string> {
    return {
      provider: "doubao-tts",
      voice: this.voice,
      endpoint: this.endpoint,
    }
  }
}

class DoubaoTtsSession implements StreamingTtsSession {
  private inflight?: AbortController

  constructor(
    private readonly apiKey: string,
    private readonly options: {
      endpoint: string
      voice: string
      uid: string
      chunkTimeoutMs: number
      fetchImpl: typeof fetch
      requestIdFactory: () => string
    }
  ) {}

  async *synthesize(text: string): AsyncIterable<TtsAudioChunk> {
    const trimmed = text.trim()
    if (!trimmed) return
    const controller = new AbortController()
    this.inflight = controller
    let connectTimedOut = false
    const connectTimer = setTimeout(() => {
      connectTimedOut = true
      controller.abort()
    }, CONNECT_TIMEOUT_MS)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const request = {
        method: "POST" as const,
        headers: buildDoubaoTtsHeaders(
          this.apiKey,
          this.options.requestIdFactory()
        ),
        body: JSON.stringify(
          buildDoubaoTtsRequestBody(
            trimmed,
            this.options.voice,
            this.options.uid
          )
        ),
        signal: controller.signal,
      }
      let response: Response
      try {
        response = await this.options.fetchImpl(this.options.endpoint, request)
      } catch (error) {
        if (controller.signal.aborted) {
          if (connectTimedOut)
            throw new DoubaoProviderError("tts_connect_timeout", "", true)
          throw new DoubaoProviderError("tts_request_aborted", "", true)
        }
        throw new DoubaoProviderError(
          "tts_transport_failed",
          describe(error, this.apiKey),
          true
        )
      } finally {
        clearTimeout(connectTimer)
      }
      if (!response.ok || !response.body) {
        const detail = await summarizeErrorBody(response, this.apiKey)
        throw new DoubaoProviderError(
          `tts_request_failed_status_${response.status}`,
          detail
        )
      }

      reader = response.body.getReader()
      const scanner = createStreamObjectScanner()
      const decoder = new TextDecoder()
      let sawEnd = false
      stream: for (;;) {
        const { done, value } = await readChunk(
          reader,
          controller,
          this.options.chunkTimeoutMs
        )
        if (done) break
        for (const raw of scanner.push(
          decoder.decode(value, { stream: true })
        )) {
          const outcome = this.consumeObject(raw)
          if (outcome.kind === "audio") {
            yield outcome.chunk
          } else if (outcome.kind === "error") {
            throw new DoubaoProviderError(
              `doubao_tts_error_${outcome.code}`,
              describe({ message: outcome.message }, this.apiKey)
            )
          } else if (outcome.kind === "end") {
            sawEnd = true
            break stream
          }
        }
      }
      if (!sawEnd) {
        for (const raw of scanner.flush()) {
          const outcome = this.consumeObject(raw)
          if (outcome.kind === "audio") yield outcome.chunk
          else if (outcome.kind === "error")
            throw new DoubaoProviderError(
              `doubao_tts_error_${outcome.code}`,
              describe({ message: outcome.message }, this.apiKey)
            )
          else if (outcome.kind === "end") sawEnd = true
        }
      }
      if (!sawEnd)
        throw new DoubaoProviderError(
          "tts_stream_ended_before_completion",
          "",
          true
        )
    } finally {
      if (this.inflight === controller) this.inflight = undefined
      clearTimeout(connectTimer)
      await reader?.cancel().catch(() => undefined)
      controller.abort()
    }
  }

  async close(): Promise<void> {
    this.inflight?.abort()
    this.inflight = undefined
  }

  toJSON(): Record<string, string> {
    return { session: "doubao-tts" }
  }

  private consumeObject(
    raw: string
  ):
    | { kind: "audio"; chunk: TtsAudioChunk }
    | { kind: "end" }
    | { kind: "error"; code: number; message: string } {
    const object = classifyTtsStreamObject(raw)
    if (object.kind === "audio")
      return {
        kind: "audio",
        chunk: {
          codec: "pcm_s16le",
          sampleRateHz: DOUBAO_TTS_SAMPLE_RATE_HZ,
          channels: 1,
          data: new Uint8Array(Buffer.from(object.base64, "base64")),
        },
      }
    if (object.kind === "error")
      return { kind: "error", code: object.code, message: object.message }
    return { kind: "end" }
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Racing the abort signal keeps close()/cancel() deterministic even when
  // the underlying stream implementation leaves read() pending on abort.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DoubaoProviderError("tts_request_aborted", "", true)),
      { once: true }
    )
  })
  try {
    return await Promise.race([
      reader.read(),
      aborted,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Settle as a timeout before aborting, or the abort listener
          // would win this race and misreport the failure reason.
          reject(new DoubaoProviderError("tts_chunk_timeout", "", true))
          controller.abort()
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    if (!(error instanceof DoubaoProviderError) && controller.signal.aborted)
      throw new DoubaoProviderError("tts_request_aborted", "", true)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function summarizeErrorBody(
  response: Response,
  apiKey: string
): Promise<string> {
  let text = ""
  try {
    text = await response.text()
  } catch {
    return ""
  }
  const object = classifyTtsStreamObject(text.trim())
  const message =
    object.kind === "error"
      ? object.message
      : text.slice(0, MAX_ERROR_MESSAGE_CHARS)
  return describe({ message }, apiKey)
}

function describe(source: unknown, apiKey: string): string {
  const raw =
    source instanceof Error
      ? source.message
      : typeof source === "object" &&
          source !== null &&
          typeof (source as { message?: unknown }).message === "string"
        ? (source as { message: string }).message
        : ""
  if (!raw.trim()) return ""
  return safeErrorMessage(raw.slice(0, MAX_ERROR_MESSAGE_CHARS), [apiKey])
}
