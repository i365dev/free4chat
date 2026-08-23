import assert from "node:assert/strict"
import { gunzipSync, gzipSync } from "node:zlib"
import { test } from "node:test"

import type { AudioFrame } from "../src/media/types.js"
import {
  buildInitialRequest,
  createDoubaoHeaders,
  parseResponse,
} from "../src/speech/providers/doubao/protocol.js"
import {
  DoubaoSttProvider,
  type DoubaoWebSocketLike,
} from "../src/speech/providers/doubao/provider.js"

type Listener = (...args: unknown[]) => void

class FakeWebSocket implements DoubaoWebSocketLike {
  static instances: FakeWebSocket[] = []
  readyState = 0
  readonly sent: Buffer[] = []
  private readonly listeners = new Map<string, Listener[]>()
  private audioMessages = 0

  constructor(
    readonly url: string,
    readonly options: { headers: Record<string, string> }
  ) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open")
    })
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  send(data: Buffer, callback?: (error?: Error) => void): void {
    this.sent.push(data)
    if (this.sent.length === 1) {
      this.emit("message", responseFrame({}))
      callback?.()
      return
    }
    this.audioMessages += 1
    if (this.audioMessages === 1)
      this.emit(
        "message",
        responseFrame({
          result: {
            utterances: [
              { start_time: 10, end_time: 110, text: "你好", definite: false },
            ],
          },
        })
      )
    else if (this.audioMessages === 2)
      this.emit(
        "message",
        responseFrame({
          result: {
            utterances: [
              { start_time: 10, end_time: 110, text: "你好", definite: false },
              { start_time: 10, end_time: 110, text: "你好", definite: true },
            ],
          },
        })
      )
    else if (this.audioMessages === 3)
      this.emit(
        "message",
        responseFrame(
          {
            result: {
              utterances: [
                {
                  start_time: 120,
                  end_time: 220,
                  text: "再见",
                  definite: true,
                },
              ],
            },
          },
          true
        )
      )
    callback?.()
  }

  close(): void {
    this.readyState = 3
    this.emit("close")
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function responseFrame(
  payload: Record<string, unknown>,
  isLastPackage = false
): Buffer {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"))
  const frame = Buffer.alloc(12 + body.length)
  frame[0] = 0x11
  frame[1] = isLastPackage ? 0x93 : 0x91
  frame[2] = 0x11
  frame.writeInt32BE(1, 4)
  frame.writeUInt32BE(body.length, 8)
  body.copy(frame, 12)
  return frame
}

function frameAudio(): AudioFrame {
  return {
    codec: "opus",
    sampleRateHz: 48_000,
    channels: 2,
    timestampMs: 0,
    data: new Uint8Array([1, 2, 3]),
  }
}

test("Doubao protocol uses current headers and JSON+gzip binary framing", () => {
  const headers = createDoubaoHeaders("api-secret", "request-id")
  assert.deepEqual(headers, {
    "X-Api-Key": "api-secret",
    "X-Api-Resource-Id": "volc.seedasr.sauc.duration",
    "X-Api-Request-Id": "request-id",
    "X-Api-Sequence": "-1",
  })

  const request = buildInitialRequest({
    audio: { codec: "opus", rate: 48_000, channel: 2 },
  })
  assert.deepEqual([...request.subarray(0, 4)], [0x11, 0x11, 0x11, 0])
  assert.equal(request.readInt32BE(4), 1)
  const size = request.readUInt32BE(8)
  const payload = JSON.parse(
    gunzipSync(request.subarray(12, 12 + size)).toString("utf8")
  ) as Record<string, Record<string, unknown>>
  assert.deepEqual(payload.audio, {
    format: "raw",
    codec: "opus",
    rate: 48_000,
    channel: 2,
  })
  assert.deepEqual(payload.request, {
    model_name: "bigmodel",
    enable_nonstream: true,
    enable_itn: true,
    enable_punc: true,
    enable_ddc: false,
    show_utterances: true,
    result_type: "full",
  })
})

test("Doubao session waits for protocol acknowledgement and normalizes semantic events", async () => {
  FakeWebSocket.instances.length = 0
  const provider = new DoubaoSttProvider("api-secret", {
    endpoint: "wss://example.invalid/asr",
    webSocketFactory: (url, options) => new FakeWebSocket(url, options),
    requestIdFactory: () => "request-id",
  })
  const session = await provider.createSession({
    audio: { codec: "opus", rate: 48_000, channel: 2 },
  })
  const socket = FakeWebSocket.instances[0]!
  assert.equal(socket.url, "wss://example.invalid/asr")
  assert.equal(socket.options.headers["X-Api-Key"], "api-secret")
  assert.equal(socket.options.headers["X-Api-Sequence"], "-1")

  await session.pushAudio(frameAudio())
  await session.pushAudio(frameAudio())
  const iterator = session.events()[Symbol.asyncIterator]()
  const events = []
  for (let index = 0; index < 4; index += 1)
    events.push((await iterator.next()).value)
  assert.deepEqual(
    events.map((event) => event?.type),
    ["speech_started", "partial", "committed", "speech_ended"]
  )
  assert.equal(
    events[1]?.type === "partial" ? events[1].text : undefined,
    "你好"
  )
  assert.deepEqual(
    socket.sent.map((frame) => frame.readInt32BE(4)),
    [1, 2, 3]
  )
  assert.deepEqual([...socket.sent[1]!.subarray(0, 4)], [0x11, 0x21, 0x11, 0])
  assert.deepEqual(
    gunzipSync(socket.sent[1]!.subarray(12)).toJSON().data,
    [1, 2, 3]
  )
  await session.close()
  assert.deepEqual(
    socket.sent.map((frame) => frame.readInt32BE(4)),
    [1, 2, 3, -4]
  )
  assert.deepEqual([...socket.sent[3]!.subarray(0, 4)], [0x11, 0x23, 0x11, 0])
  assert.deepEqual(gunzipSync(socket.sent[3]!.subarray(12)).toJSON().data, [])
  const finalEvents = []
  for await (const event of session.events()) finalEvents.push(event)
  assert.deepEqual(
    finalEvents.map((event) => event.type),
    ["speech_started", "committed", "speech_ended"]
  )
  assert.equal(
    finalEvents[1]?.type === "committed" ? finalEvents[1].text : undefined,
    "再见"
  )
  await session.close()
  assert.equal(socket.readyState, 3)
})

test("Doubao response parser rejects malformed binary frames", () => {
  assert.throws(() => parseResponse(new Uint8Array([0x11])), /invalid Doubao/)
})
