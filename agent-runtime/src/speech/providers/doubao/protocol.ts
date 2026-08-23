import { gunzipSync, gzipSync } from "node:zlib"

import { randomUUID } from "node:crypto"

import type { AudioFrame } from "../../../media/types.js"

export const DOUBAO_ENDPOINT =
  "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
export const DOUBAO_RESOURCE_ID = "volc.seedasr.sauc.duration"

const PROTOCOL_VERSION = 0x1
const HEADER_SIZE_WORDS = 0x1
const CLIENT_FULL_REQUEST = 0x1
const CLIENT_AUDIO_ONLY_REQUEST = 0x2
const SERVER_FULL_RESPONSE = 0x9
const SERVER_ERROR_RESPONSE = 0xf
const POSITIVE_SEQUENCE = 0x1
const NEGATIVE_SEQUENCE_WITH_SEQUENCE = 0x3
const JSON_SERIALIZATION = 0x1
const GZIP_COMPRESSION = 0x1
const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024

export interface DoubaoAudioConfig {
  format: "pcm" | "wav" | "ogg" | "mp3"
  codec: "opus" | "raw"
  rate: number
  bits?: number
  channel: number
}

export interface DoubaoRequestOptions {
  audio?: Partial<DoubaoAudioConfig>
  uid?: string
}

export interface DoubaoUtterance {
  text?: unknown
  definite?: unknown
  start_time?: unknown
  end_time?: unknown
}

export interface DoubaoResponsePayload {
  result?: unknown
  text?: unknown
  utterances?: unknown
  error?: unknown
}

export interface DoubaoResponse {
  code: number
  event: number
  isLastPackage: boolean
  payloadSequence?: number
  payload?: DoubaoResponsePayload
}

export type DoubaoHeaders = Record<string, string> & {
  "X-Api-Key": string
  "X-Api-Resource-Id": string
  "X-Api-Request-Id": string
  "X-Api-Sequence": "-1"
}

export function createDoubaoHeaders(
  apiKey: string,
  requestId: string = randomUUID()
): DoubaoHeaders {
  return {
    "X-Api-Key": apiKey,
    "X-Api-Resource-Id": DOUBAO_RESOURCE_ID,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  }
}

function makeHeader(messageType: number, flags: number): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
    (messageType << 4) | flags,
    (JSON_SERIALIZATION << 4) | GZIP_COMPRESSION,
    0,
  ])
}

function withLength(payload: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(payload.length)
  return length
}

export function buildInitialRequest(
  options: DoubaoRequestOptions = {}
): Buffer {
  const audio: DoubaoAudioConfig = {
    format: options.audio?.codec === "opus" ? "ogg" : "pcm",
    codec: options.audio?.codec ?? "opus",
    rate: options.audio?.rate ?? 48_000,
    channel: options.audio?.channel ?? 2,
    ...(options.audio?.bits ? { bits: options.audio.bits } : {}),
  }
  const payload = gzipSync(
    Buffer.from(
      JSON.stringify({
        user: { uid: options.uid ?? "free4chat-agent" },
        audio,
        request: {
          model_name: "bigmodel",
          enable_nonstream: true,
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
          show_utterances: true,
          result_type: "full",
        },
      }),
      "utf8"
    )
  )
  const sequence = Buffer.allocUnsafe(4)
  sequence.writeInt32BE(1)
  return Buffer.concat([
    makeHeader(CLIENT_FULL_REQUEST, POSITIVE_SEQUENCE),
    sequence,
    withLength(payload),
    payload,
  ])
}

export function buildAudioRequest(
  sequenceNumber: number,
  data: Uint8Array
): Buffer {
  const isFinal = sequenceNumber < 0
  const payload = gzipSync(Buffer.from(data))
  const sequence = Buffer.allocUnsafe(4)
  sequence.writeInt32BE(sequenceNumber)
  return Buffer.concat([
    makeHeader(
      CLIENT_AUDIO_ONLY_REQUEST,
      isFinal ? NEGATIVE_SEQUENCE_WITH_SEQUENCE : POSITIVE_SEQUENCE
    ),
    sequence,
    withLength(payload),
    payload,
  ])
}

function readUInt32(payload: Buffer, offset: number): number {
  if (offset + 4 > payload.length) throw protocolError()
  return payload.readUInt32BE(offset)
}

function readInt32(payload: Buffer, offset: number): number {
  if (offset + 4 > payload.length) throw protocolError()
  return payload.readInt32BE(offset)
}

function protocolError(): Error {
  return new Error("invalid Doubao speech protocol frame")
}

export function parseResponse(message: Uint8Array): DoubaoResponse {
  const frame = Buffer.from(message)
  if (frame.length < 4) throw protocolError()
  const headerSize = (frame[0] ?? 0) & 0x0f
  if (headerSize < 1 || frame.length < headerSize * 4) throw protocolError()

  const messageType = ((frame[1] ?? 0) >> 4) & 0x0f
  const flags = (frame[1] ?? 0) & 0x0f
  const serialization = ((frame[2] ?? 0) >> 4) & 0x0f
  const compression = (frame[2] ?? 0) & 0x0f
  let offset = headerSize * 4
  let payloadSequence: number | undefined
  if (flags & 0x1) {
    payloadSequence = readInt32(frame, offset)
    offset += 4
  }
  const isLastPackage = Boolean(flags & 0x2)
  if (flags & 0x4) {
    // The event field is meaningful to some server messages, but the ASR
    // result is carried in the JSON payload. Consume it to keep framing
    // correct without coupling the provider to event enum values.
    readInt32(frame, offset)
    offset += 4
  }

  let code = 0
  if (messageType === SERVER_FULL_RESPONSE) {
    const payloadSize = readUInt32(frame, offset)
    offset += 4
    if (
      payloadSize > MAX_FRAME_PAYLOAD_BYTES ||
      offset + payloadSize > frame.length
    )
      throw protocolError()
  } else if (messageType === SERVER_ERROR_RESPONSE) {
    code = readInt32(frame, offset)
    const payloadSize = readUInt32(frame, offset + 4)
    offset += 8
    if (
      payloadSize > MAX_FRAME_PAYLOAD_BYTES ||
      offset + payloadSize > frame.length
    )
      throw protocolError()
  }

  if (offset > frame.length) throw protocolError()
  let body = frame.subarray(offset)
  if (compression === GZIP_COMPRESSION) {
    try {
      body = gunzipSync(body)
    } catch {
      throw protocolError()
    }
  }
  let payload: DoubaoResponsePayload | undefined
  if (body.length > 0 && serialization === JSON_SERIALIZATION) {
    try {
      const decoded: unknown = JSON.parse(body.toString("utf8"))
      if (decoded && typeof decoded === "object")
        payload = decoded as DoubaoResponsePayload
    } catch {
      throw protocolError()
    }
  }
  return { code, event: 0, isLastPackage, payloadSequence, payload }
}

export function audioConfigFromFrame(frame: AudioFrame): DoubaoAudioConfig {
  if (frame.codec === "opus") {
    return {
      format: "ogg",
      codec: "opus",
      rate: frame.sampleRateHz,
      channel: frame.channels,
    }
  }
  return {
    format: "pcm",
    codec: "raw",
    rate: frame.sampleRateHz,
    bits: 16,
    channel: frame.channels,
  }
}

export function responseUtterances(
  payload: DoubaoResponsePayload | undefined
): DoubaoUtterance[] {
  if (!payload) return []
  const result = payload.result
  if (Array.isArray(result)) {
    return result.flatMap((item) => {
      if (!isObject(item)) return []
      if (Array.isArray(item.utterances))
        return item.utterances.filter(isObject) as DoubaoUtterance[]
      return [item as DoubaoUtterance]
    })
  }
  if (isObject(result) && Array.isArray(result.utterances))
    return result.utterances.filter(isObject) as DoubaoUtterance[]
  if (Array.isArray(payload.utterances))
    return payload.utterances.filter(isObject) as DoubaoUtterance[]
  if (isObject(result) && typeof result.text === "string")
    return [result as DoubaoUtterance]
  return typeof payload.text === "string" ? [{ text: payload.text }] : []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
