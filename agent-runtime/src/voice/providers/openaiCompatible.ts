import type {
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsAudioChunk,
} from "../../speech/types.js"
import { safeErrorMessage } from "../../speech/redaction.js"

/** Raw PCM frame size handed to the outbound sink: 2048 samples of 16-bit
 * mono audio (~85 ms at 24 kHz) balances per-write overhead against
 * cancellation granularity. */
const DEFAULT_FRAME_BYTES = 4096
const DEFAULT_SAMPLE_RATE_HZ = 24_000

export const OPENAI_COMPATIBLE_TTS_DEFAULT_BASE_URL =
  "https://api.openai.com/v1"
export const OPENAI_COMPATIBLE_TTS_DEFAULT_MODEL = "gpt-4o-mini-tts"
export const OPENAI_COMPATIBLE_TTS_DEFAULT_VOICE = "alloy"

export interface OpenAiCompatibleTtsOptions {
  /** Injectable fetch so unit tests stay deterministic and offline. */
  fetchImpl?: typeof fetch
  frameBytes?: number
}

interface ResolvedConfig {
  baseUrl: string
  apiKey: string
  model: string
  voice: string
}

/**
 * Maps resolved BYOK setup values onto an OpenAI-compatible
 * POST /audio/speech call returning raw PCM. The API key exists only
 * inside the Authorization header of outgoing requests; every failure
 * surface is sanitized through safeErrorMessage so a leaked response body
 * can never echo credentials into logs or room diagnostics.
 */
export class OpenAiCompatibleTtsProvider implements StreamingTtsProvider {
  private readonly config: ResolvedConfig
  private readonly fetchImpl: typeof fetch
  private readonly frameBytes: number

  constructor(
    values: Record<string, string>,
    options: OpenAiCompatibleTtsOptions = {}
  ) {
    this.config = resolveConfig(values)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.frameBytes = Math.max(2, options.frameBytes ?? DEFAULT_FRAME_BYTES)
  }

  async createSession(): Promise<StreamingTtsSession> {
    return new OpenAiCompatibleTtsSession(
      this.config,
      this.fetchImpl,
      this.frameBytes
    )
  }
}

class OpenAiCompatibleTtsSession implements StreamingTtsSession {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly fetchImpl: typeof fetch,
    private readonly frameBytes: number
  ) {}

  async *synthesize(text: string): AsyncIterable<TtsAudioChunk> {
    const trimmed = text.trim()
    if (!trimmed) return
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/audio/speech`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          voice: this.config.voice,
          input: trimmed,
          response_format: "pcm",
        }),
      })
    } catch (error) {
      throw new Error(sanitize(error, this.config.apiKey))
    }
    if (!response.ok) {
      // The status alone is diagnostic enough; the body is deliberately not
      // read because providers sometimes echo request material in errors.
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`tts_request_failed_status_${response.status}`)
    }
    const audio = new Uint8Array(await response.arrayBuffer())
    for (let offset = 0; offset < audio.length; offset += this.frameBytes)
      yield {
        codec: "pcm_s16le",
        sampleRateHz: DEFAULT_SAMPLE_RATE_HZ,
        channels: 1,
        data: audio.subarray(offset, offset + this.frameBytes),
      }
  }

  async close(): Promise<void> {}
}

function resolveConfig(values: Record<string, string>): ResolvedConfig {
  const baseUrl = values.baseUrl?.trim()
  return {
    baseUrl: baseUrl ? baseUrl : OPENAI_COMPATIBLE_TTS_DEFAULT_BASE_URL,
    apiKey: values.apiKey ?? "",
    model: values.model?.trim() || OPENAI_COMPATIBLE_TTS_DEFAULT_MODEL,
    voice: values.voice?.trim() || OPENAI_COMPATIBLE_TTS_DEFAULT_VOICE,
  }
}

function sanitize(error: unknown, apiKey: string): string {
  return `tts_transport_failed: ${safeErrorMessage(error, [apiKey])}`
}
