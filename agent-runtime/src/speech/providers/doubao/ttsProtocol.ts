/**
 * Wire helpers for Doubao Speech Synthesis 2.0 (豆包语音合成模型 2.0) over the
 * official V3 output-unidirectional HTTP interface:
 *
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   X-Api-Key / X-Api-Resource-Id: seed-tts-2.0 / X-Api-Request-Id
 *
 * The chunked response body is a stream of JSON objects ({code, message?,
 * data?}): code 0 carries one base64 audio chunk in `data`; code 20000000 is
 * the successful termination marker; any other code is an error. With
 * format "pcm" the decoded audio is raw 24 kHz 16-bit mono little-endian
 * PCM, which is exactly the Runtime sink's canonical format. Objects may be
 * newline-separated or concatenated, so extraction is brace-based rather
 * than line-based.
 */

export const DOUBAO_TTS_ENDPOINT =
  "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
export const DOUBAO_TTS_RESOURCE_ID = "seed-tts-2.0"
export const DOUBAO_TTS_DEFAULT_VOICE = "zh_female_shuangkuaisisi_uranus_bigtts"
export const DOUBAO_TTS_SAMPLE_RATE_HZ = 24_000

/** Successful stream termination business code (20000000). */
export const DOUBAO_TTS_END_CODE = 20_000_000

export function buildDoubaoTtsHeaders(
  apiKey: string,
  requestId: string
): Record<string, string> {
  return {
    "X-Api-Key": apiKey,
    "X-Api-Resource-Id": DOUBAO_TTS_RESOURCE_ID,
    "X-Api-Request-Id": requestId,
    "Content-Type": "application/json",
  }
}

export function buildDoubaoTtsRequestBody(
  text: string,
  voice: string,
  uid = "free4chat-agent"
): Record<string, unknown> {
  return {
    user: { uid },
    req_params: {
      text,
      speaker: voice,
      audio_params: {
        format: "pcm",
        sample_rate: DOUBAO_TTS_SAMPLE_RATE_HZ,
      },
    },
  }
}

export type TtsStreamObject =
  | { kind: "audio"; base64: string }
  | { kind: "end" }
  | { kind: "error"; code: number; message: string }
  | { kind: "invalid" }

export function classifyTtsStreamObject(raw: string): TtsStreamObject {
  let parsed: {
    code?: unknown
    message?: unknown
    data?: unknown
    header?: { code?: unknown; message?: unknown }
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "invalid" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { kind: "invalid" }
  const code = Number(parsed.code ?? parsed.header?.code ?? 0)
  if (Number.isFinite(code) && code !== 0 && code !== DOUBAO_TTS_END_CODE)
    return {
      kind: "error",
      code,
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.header?.message === "string"
            ? parsed.header.message
            : "",
    }
  if (code === DOUBAO_TTS_END_CODE) return { kind: "end" }
  return typeof parsed.data === "string" && parsed.data.length > 0
    ? { kind: "audio", base64: parsed.data }
    : // A code-0 object without an audio payload is malformed, never a
      // completion: treating it as one would silently truncate answers.
      { kind: "invalid" }
}

/**
 * Incremental extractor for complete top-level JSON objects inside a
 * chunked stream. Brace-aware and string-aware (escaped quotes never break
 * depth tracking), tolerant of newlines, partial lines, and concatenated
 * objects; anything incomplete stays buffered until more text arrives.
 */
export function createStreamObjectScanner(): {
  push(text: string): string[]
  flush(): string[]
} {
  let buffer = ""
  let pos = 0
  let objectStart = -1
  let depth = 0
  let inString = false
  let escaped = false
  const objects: string[] = []

  function run(untilEOF: boolean): void {
    while (pos < buffer.length) {
      const ch = buffer[pos]
      if (depth === 0) {
        if (ch === "{") {
          depth = 1
          objectStart = pos
          inString = false
          escaped = false
        }
        pos += 1
        continue
      }
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        pos += 1
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth += 1
      else if (ch === "}") {
        depth -= 1
        if (depth === 0 && objectStart >= 0) {
          objects.push(buffer.slice(objectStart, pos + 1))
          objectStart = -1
          // Everything before this point is consumed; dropping it keeps the
          // buffer bounded on long audio streams.
          buffer = buffer.slice(pos + 1)
          pos = 0
          continue
        }
      }
      pos += 1
    }
    if (untilEOF) return
    if (objectStart > 0) {
      // Trim the unconsumed garbage before an open object.
      buffer = buffer.slice(objectStart)
      pos -= objectStart
      objectStart = 0
    } else if (objectStart < 0 && depth === 0) {
      buffer = ""
      pos = 0
    }
  }

  return {
    push(text: string): string[] {
      if (text) buffer += text
      run(false)
      return objects.splice(0)
    },
    flush(): string[] {
      run(true)
      const ready = objects.splice(0)
      buffer = ""
      pos = 0
      return ready
    },
  }
}

export function pcmSilenceWavHeader(
  pcmByteLength: number,
  sampleRateHz = DOUBAO_TTS_SAMPLE_RATE_HZ,
  channels = 1,
  bitsPerSample = 16
): Buffer {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0, "ascii")
  header.writeUInt32LE(36 + pcmByteLength, 4)
  header.write("WAVE", 8, "ascii")
  header.write("fmt ", 12, "ascii")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRateHz, 24)
  header.writeUInt32LE((sampleRateHz * channels * bitsPerSample) / 8, 28)
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write("data", 36, "ascii")
  header.writeUInt32LE(pcmByteLength, 40)
  return header
}
