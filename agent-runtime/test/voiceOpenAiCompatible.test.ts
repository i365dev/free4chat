import assert from "node:assert/strict"
import { test } from "node:test"

import type { TtsAudioChunk } from "../src/speech/types.js"
import {
  OPENAI_COMPATIBLE_TTS_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_TTS_DEFAULT_MODEL,
  OPENAI_COMPATIBLE_TTS_DEFAULT_VOICE,
  OpenAiCompatibleTtsProvider,
} from "../src/voice/providers/openaiCompatible.js"
import { openAiCompatibleSpeechProvider } from "../src/voice/providers/openaiCompatibleDescriptor.js"
import { productionSpeechRegistry } from "../src/speech/registry.js"

const API_KEY = "sk-super-secret-key-value"

interface CapturedRequest {
  url: string
  init: RequestInit
}

function fetchCapturing(
  body: ArrayBuffer | number,
  status = 200
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} })
    const payload =
      body instanceof ArrayBuffer ? body : new ArrayBuffer(Math.max(0, body))
    return new Response(payload, {
      status,
      headers: { "content-type": "application/octet-stream" },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

async function collect(
  provider: OpenAiCompatibleTtsProvider,
  text: string
): Promise<TtsAudioChunk[]> {
  const session = await provider.createSession()
  const chunks: TtsAudioChunk[] = []
  for await (const audio of session.synthesize(text)) chunks.push(audio)
  await session.close()
  return chunks
}

test("maps setup values onto the OpenAI-compatible speech request", async () => {
  const { fetchImpl, requests } = fetchCapturing(new ArrayBuffer(8))
  const provider = new OpenAiCompatibleTtsProvider(
    {
      apiKey: API_KEY,
      baseUrl: "https://tts.example.internal/v1/",
      model: "my-tts-model",
      voice: "narrator",
    },
    { fetchImpl }
  )
  await collect(provider, " Hello world. ")
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.url, "https://tts.example.internal/v1/audio/speech")
  assert.equal(
    request.init.headers &&
      (request.init.headers as Record<string, string>)["Authorization"],
    `Bearer ${API_KEY}`
  )
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
  assert.deepEqual(body, {
    model: "my-tts-model",
    voice: "narrator",
    input: "Hello world.",
    response_format: "pcm",
  })
})

test("falls back to defaults when optional values are absent", async () => {
  const { fetchImpl, requests } = fetchCapturing(new ArrayBuffer(8))
  const provider = new OpenAiCompatibleTtsProvider(
    { apiKey: API_KEY },
    { fetchImpl }
  )
  await collect(provider, "Hi")
  const request = requests[0]!
  assert.equal(
    request.url,
    `${OPENAI_COMPATIBLE_TTS_DEFAULT_BASE_URL}/audio/speech`
  )
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
  assert.equal(body.model, OPENAI_COMPATIBLE_TTS_DEFAULT_MODEL)
  assert.equal(body.voice, OPENAI_COMPATIBLE_TTS_DEFAULT_VOICE)
})

test("frames raw PCM into fixed-size chunks with a final partial frame", async () => {
  const sampleCount = 2048 + 100
  const bytes = new ArrayBuffer(sampleCount * 2)
  new Uint8Array(bytes).fill(0x7f)
  const { fetchImpl } = fetchCapturing(bytes)
  const provider = new OpenAiCompatibleTtsProvider(
    { apiKey: API_KEY },
    { fetchImpl }
  )
  const chunks = await collect(provider, "Speak.")
  assert.equal(chunks.length, 2)
  const [first, second] = chunks
  assert.equal(first!.data.byteLength, 4096)
  assert.equal(second!.data.byteLength, 200)
  for (const audio of chunks) {
    assert.equal(audio.codec, "pcm_s16le")
    assert.equal(audio.sampleRateHz, 24_000)
    assert.equal(audio.channels, 1)
  }
})

test("empty text never issues a network request", async () => {
  const { fetchImpl, requests } = fetchCapturing(new ArrayBuffer(0))
  const provider = new OpenAiCompatibleTtsProvider(
    { apiKey: API_KEY },
    { fetchImpl }
  )
  const chunks = await collect(provider, "   ")
  assert.deepEqual(chunks, [])
  assert.equal(requests.length, 0)
})

test("HTTP failures expose only a status code and never the credential", async () => {
  const { fetchImpl } = fetchCapturing(new ArrayBuffer(0), 500)
  const provider = new OpenAiCompatibleTtsProvider(
    { apiKey: API_KEY },
    { fetchImpl }
  )
  await assert.rejects(
    async () => void (await collect(provider, "Hello")),
    /tts_request_failed_status_500/
  )
})

test("transport failures are sanitized and never echo the credential", async () => {
  const failingFetch = (async () => {
    throw new Error(`connect ECONNREFUSED leaked=${API_KEY}`)
  }) as unknown as typeof fetch
  const provider = new OpenAiCompatibleTtsProvider(
    { apiKey: API_KEY },
    { fetchImpl: failingFetch }
  )
  let message = ""
  try {
    await collect(provider, "Hello")
  } catch (error) {
    message = error instanceof Error ? error.message : ""
  }
  assert.ok(message.startsWith("tts_transport_failed:"))
  assert.ok(!message.includes(API_KEY))
})

test("descriptor advertises tts capability with an offline validation contract", async () => {
  assert.deepEqual(openAiCompatibleSpeechProvider.capabilities, ["tts"])
  assert.equal(openAiCompatibleSpeechProvider.createSttProvider, undefined)
  const missing = await openAiCompatibleSpeechProvider.validate({})
  assert.equal(missing.valid, false)
  const present = await openAiCompatibleSpeechProvider.validate({
    apiKey: "x",
  })
  assert.equal(present.valid, true)
  const diagnosis = await openAiCompatibleSpeechProvider.diagnose({})
  assert.equal(diagnosis.ready, false)
})

test("the production registry resolves both speech capabilities", () => {
  const registry = productionSpeechRegistry()
  assert.equal(registry.get("doubao")?.capabilities.includes("stt"), true)
  assert.equal(
    registry.get("openai-compatible")?.capabilities.includes("tts"),
    true
  )
  // The descriptor is room-safe to enumerate: no secret material inline.
  const serialized = JSON.stringify(registry.list())
  assert.ok(!serialized.includes(API_KEY))
})
