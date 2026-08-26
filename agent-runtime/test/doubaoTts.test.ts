import assert from "node:assert/strict"
import { test } from "node:test"

import type { StreamingTtsSession, TtsAudioChunk } from "../src/speech/types.js"
import { DoubaoProviderError } from "../src/speech/providers/doubao/provider.js"
import { DoubaoTtsProvider } from "../src/speech/providers/doubao/ttsProvider.js"
import {
  buildDoubaoTtsRequestBody,
  classifyTtsStreamObject,
  createStreamObjectScanner,
  DOUBAO_TTS_DEFAULT_VOICE,
  DOUBAO_TTS_ENDPOINT,
  DOUBAO_TTS_RESOURCE_ID,
  DOUBAO_TTS_SAMPLE_RATE_HZ,
  pcmSilenceWavHeader,
} from "../src/speech/providers/doubao/ttsProtocol.js"

const API_KEY = "sk-doubao-secret"

interface CapturedRequest {
  url: string
  init: RequestInit
}

function pcmLine(bytes: Uint8Array): string {
  return `${JSON.stringify({ code: 0, data: Buffer.from(bytes).toString("base64") })}\n`
}

const END_LINE = `${JSON.stringify({ code: 20_000_000, message: "ok" })}\n`

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = lines.join("")
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}

async function collect(
  provider: DoubaoTtsProvider,
  text: string
): Promise<TtsAudioChunk[]> {
  const session = await provider.createSession()
  const chunks: TtsAudioChunk[] = []
  for await (const chunk of session.synthesize(text)) chunks.push(chunk)
  await session.close()
  return chunks
}

test("request uses X-Api-Key auth, seed-tts-2.0 resource, and the V3 body schema", async () => {
  const requests: CapturedRequest[] = []
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} })
    return streamResponse([pcmLine(new Uint8Array([1])), END_LINE])
  }) as unknown as typeof fetch

  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  await collect(provider, "你好。")

  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.url, DOUBAO_TTS_ENDPOINT)
  const headers = request.init.headers as Record<string, string>
  assert.equal(headers["X-Api-Key"], API_KEY)
  assert.equal(headers["X-Api-Resource-Id"], DOUBAO_TTS_RESOURCE_ID)
  assert.match(headers["X-Api-Request-Id"], /./)
  assert.equal(headers["Content-Type"], "application/json")

  const body = JSON.parse(String(request.init.body)) as {
    user: { uid: string }
    req_params: {
      text: string
      speaker: string
      audio_params: Record<string, unknown>
    }
  }
  assert.equal(typeof body.user.uid, "string")
  assert.ok(body.user.uid.length > 0)
  assert.deepEqual(body.req_params.audio_params, {
    format: "pcm",
    sample_rate: 24_000,
  })
})

test("default voice is a 2.0 voice and DOUBAO_TTS_VOICE overrides the speaker", () => {
  assert.match(DOUBAO_TTS_DEFAULT_VOICE, /^zh_female_.*uranus_bigtts$/)
  const defaults = buildDoubaoTtsRequestBody("hi", DOUBAO_TTS_DEFAULT_VOICE)
  const overridden = buildDoubaoTtsRequestBody(
    "hi",
    "zh_male_example_uranus_bigtts"
  )
  assert.equal(
    (defaults.req_params as { speaker: string }).speaker,
    DOUBAO_TTS_DEFAULT_VOICE
  )
  assert.equal(
    (overridden.req_params as { speaker: string }).speaker,
    "zh_male_example_uranus_bigtts"
  )

  const provider = new DoubaoTtsProvider(API_KEY, {
    fetchImpl: (async () =>
      streamResponse([END_LINE])) as unknown as typeof fetch,
    voice: "zh_female_other_uranus_bigtts",
  })
  void provider
})

test("streams base64 PCM chunks in order across awkward chunk boundaries", async () => {
  // One NDJSON line split across three network chunks; objects must still
  // extract exactly once, in order.
  const firstPcm = new Uint8Array([9, 9, 9])
  const secondPcm = new Uint8Array(2048).fill(7)
  const fullBody =
    pcmLine(firstPcm) +
    pcmLine(secondPcm) +
    END_LINE +
    JSON.stringify({ code: 0 }) +
    "\n"
  const encoder = new TextEncoder()
  const encoded = encoder.encode(fullBody)
  const third = encoded.subarray(encoded.length - 5)
  const second = encoded.subarray(10, encoded.length - 5)
  const first = encoded.subarray(0, 10)

  const fetchImpl = (async (): Promise<Response> => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first)
          controller.enqueue(second)
          controller.enqueue(third)
          controller.close()
        },
      }),
      { status: 200 }
    )
  }) as unknown as typeof fetch

  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  const chunks = await collect(provider, "Speak.")
  assert.equal(chunks.length, 2)
  assert.deepEqual([...chunks[0]!.data], [...firstPcm])
  assert.deepEqual([...chunks[1]!.data], [...secondPcm])
  for (const chunk of chunks) {
    assert.equal(chunk.codec, "pcm_s16le")
    assert.equal(chunk.sampleRateHz, DOUBAO_TTS_SAMPLE_RATE_HZ)
    assert.equal(chunk.channels, 1)
  }
})

test("concatenated objects without newlines still parse", () => {
  const scanner = createStreamObjectScanner()
  const pushed = scanner.push(`{"code":0,"data":"AAA"}{"code":20000000}`)
  const flushed = scanner.flush()
  assert.equal(pushed.length + flushed.length, 2)
  assert.equal(classifyTtsStreamObject(pushed[0]!).kind, "audio")
  assert.equal(classifyTtsStreamObject(flushed[0] ?? pushed[1]!).kind, "end")
})

test("in-stream business errors surface a sanitized code and never the key", async () => {
  const errorLine = `${JSON.stringify({
    code: 55000000,
    message: `voice mismatch leaked=${API_KEY}`,
  })}\n`
  const fetchImpl = (async () =>
    streamResponse([errorLine])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  let error = undefined as unknown as DoubaoProviderError
  try {
    await collect(provider, "Hello")
  } catch (caught) {
    error = caught as DoubaoProviderError
  }
  assert.equal(error.code, "doubao_tts_error_55000000")
  assert.ok(!error.message.includes(API_KEY))
})

test("HTTP-level failures expose only the status and redacted detail", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ header: { code: 45000010, message: "Invalid key" } }),
      { status: 401 }
    )) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  await assert.rejects(
    () => collect(provider, "Hello"),
    (error: unknown) =>
      error instanceof DoubaoProviderError &&
      error.code === "tts_request_failed_status_401"
  )
})

test("a truncated stream without the terminator fails loudly", async () => {
  const fetchImpl = (async () =>
    streamResponse([
      pcmLine(new Uint8Array([1, 2, 3])),
    ])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  await assert.rejects(
    () => collect(provider, "Hello"),
    (error: unknown) =>
      error instanceof DoubaoProviderError &&
      error.code === "tts_stream_ended_before_completion"
  )
})

test("an idle stream hits the chunk timeout", async () => {
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Never enqueues anything and never closes.
        },
      }),
      { status: 200 }
    )) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, {
    fetchImpl,
    chunkTimeoutMs: 30,
  })
  await assert.rejects(
    () => collect(provider, "Hello"),
    (error: unknown) =>
      error instanceof DoubaoProviderError && error.code === "tts_chunk_timeout"
  )
})

test("close() aborts an in-flight synthesis promptly", async () => {
  let abortedSeen = false
  const fetchImpl = (async (
    _input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    init?.signal?.addEventListener("abort", () => {
      abortedSeen = true
    })
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Stalls forever until aborted.
        },
      }),
      { status: 200 }
    )
  }) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, {
    fetchImpl,
    chunkTimeoutMs: 30_000,
  })
  const session: StreamingTtsSession = await provider.createSession()
  const iterator = session.synthesize("Hello")[Symbol.asyncIterator]()
  const draining = iterator.next()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await session.close()
  await assert.rejects(
    () => draining,
    (error: unknown) =>
      error instanceof DoubaoProviderError &&
      error.code === "tts_request_aborted"
  )
  assert.equal(abortedSeen, true)
})

test("empty or whitespace-only text never issues a request", async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return streamResponse([END_LINE])
  }) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  const chunks = await collect(provider, "   ")
  assert.deepEqual(chunks, [])
  assert.equal(calls, 0)
})

test("missing api key fails before any session exists", async () => {
  const provider = new DoubaoTtsProvider("", {})
  await assert.rejects(() => provider.createSession(), /api key is required/i)
})

test("serializing the resolved provider or session never exposes the credential", async () => {
  const provider = new DoubaoTtsProvider(API_KEY, {
    fetchImpl: (async () => streamResponse([])) as unknown as typeof fetch,
  })
  const session = await provider.createSession()
  for (const value of [provider, session]) {
    const serialized = JSON.stringify(value)
    assert.ok(!serialized.includes(API_KEY))
  }
})

test("a balanced but malformed object fails as a protocol error, not completion", async () => {
  const fetchImpl = (async () =>
    streamResponse([
      `${JSON.stringify({ event: "unexpected", note: "not part of the contract" })}\n`,
    ])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  await assert.rejects(
    () => collect(provider, "Hello"),
    (error: unknown) =>
      error instanceof DoubaoProviderError &&
      error.code === "tts_invalid_stream_object"
  )
})

test("a code-0 object without audio data fails instead of completing", async () => {
  const fetchImpl = (async () =>
    streamResponse([
      `${JSON.stringify({ code: 0, data: "" })}\n`,
    ])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  await assert.rejects(
    () => collect(provider, "Hello"),
    (error: unknown) =>
      error instanceof DoubaoProviderError &&
      error.code === "tts_invalid_stream_object"
  )
})

test("only the official terminator code completes a stream", async () => {
  const fetchImpl = (async () =>
    streamResponse([END_LINE])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  const chunks = await collect(provider, "Hello")
  assert.deepEqual(chunks, [])
})

test("classifier maps every stream object shape deterministically", () => {
  assert.equal(classifyTtsStreamObject("not json at all").kind, "invalid")
  assert.equal(classifyTtsStreamObject("[1,2]").kind, "invalid")
  assert.equal(classifyTtsStreamObject('{"code":0}').kind, "invalid")
  assert.equal(
    classifyTtsStreamObject('{"code":0,"data":null}').kind,
    "invalid"
  )
  assert.equal(
    classifyTtsStreamObject(
      '{"code":0,"message":"","data":null,"sentence":{"phonemes":[],"text":"hi","words":[]}}'
    ).kind,
    "metadata"
  )
  assert.equal(classifyTtsStreamObject('{"code":0,"data":"AAA"}').kind, "audio")
  assert.deepEqual(classifyTtsStreamObject('{"code":20000000}'), {
    kind: "end",
  })
  const businessError = classifyTtsStreamObject(
    '{"code":55000000,"message":"mismatch"}'
  )
  assert.equal(businessError.kind, "error")
  assert.ok(businessError.kind === "error" && businessError.code === 55000000)
})

test("real Doubao streams with code-0 sentence metadata frames complete cleanly", async () => {
  // Reproduces the live V3 response shape: audio frames interleaved with a
  // data:null sentence-metadata frame, then the terminator.
  const audioA = new Uint8Array([1, 2, 3])
  const audioB = new Uint8Array(1024).fill(5)
  const metadataLine = `${JSON.stringify({
    code: 0,
    message: "",
    data: null,
    sentence: {
      phonemes: [],
      text: "你好，这是 Free4Chat 豆包语音合成 2.0 的本地测试。",
      words: [],
    },
  })}\n`
  const fetchImpl = (async () =>
    streamResponse([
      pcmLine(audioA),
      metadataLine,
      pcmLine(audioB),
      END_LINE,
    ])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  const chunks = await collect(provider, "你好。")
  assert.equal(chunks.length, 2)
  assert.deepEqual([...chunks[0]!.data], [...audioA])
  assert.deepEqual([...chunks[1]!.data], [...audioB])
})

test("code-0 frames without data and without sentence metadata still fail closed", async () => {
  const fetchImpl = (async () =>
    streamResponse([
      `${JSON.stringify({ code: 0, message: "", data: null })}\n`,
    ])) as unknown as typeof fetch
  const provider = new DoubaoTtsProvider(API_KEY, { fetchImpl })
  await assert.rejects(
    () => collect(provider, "Hello"),
    (error: unknown) =>
      error instanceof DoubaoProviderError &&
      error.code === "tts_invalid_stream_object"
  )
})

test("wav wrapping emits a canonical 44-byte PCM header", () => {
  const header = pcmSilenceWavHeader(48000)
  assert.equal(header.byteLength, 44)
  assert.equal(header.toString("ascii", 0, 4), "RIFF")
  assert.equal(header.readUInt32LE(4), 36 + 48000)
  assert.equal(header.toString("ascii", 8, 12), "WAVE")
  assert.equal(header.readUInt16LE(20), 1)
  assert.equal(header.readUInt16LE(22), 1)
  assert.equal(header.readUInt32LE(24), DOUBAO_TTS_SAMPLE_RATE_HZ)
  assert.equal(header.readUInt32LE(28), DOUBAO_TTS_SAMPLE_RATE_HZ * 2)
  assert.equal(header.readUInt32LE(40), 48000)
})
