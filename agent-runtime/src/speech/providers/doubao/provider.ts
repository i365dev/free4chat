import { randomUUID } from "node:crypto"

import WebSocket from "ws"

import type { AudioFrame } from "../../../media/types.js"
import type {
  SttError,
  SttEvent,
  SttSessionOptions,
  StreamingSttProvider,
  StreamingSttSession,
} from "../../types.js"
import {
  buildAudioRequest,
  buildInitialRequest,
  createDoubaoHeaders,
  DOUBAO_ENDPOINT,
  parseResponse,
  responseUtterances,
  type DoubaoHeaders,
  type DoubaoRequestOptions,
  type DoubaoResponse,
  type DoubaoUtterance,
} from "./protocol.js"

const CONNECT_TIMEOUT_MS = 10_000
const CLOSE_TIMEOUT_MS = 2_000
const MAX_PENDING_EVENTS = 256
const FINAL_DRAIN_TIMEOUT_MS = 2_000
const SEND_CALLBACK_TIMEOUT_MS = 5_000

export interface DoubaoWebSocketLike {
  readonly readyState: number
  on(event: string, listener: (...args: unknown[]) => void): this
  send(data: Buffer, callback?: (error?: Error) => void): void
  close(): void
  terminate?(): void
}

export type DoubaoWebSocketFactory = (
  url: string,
  options: { headers: DoubaoHeaders }
) => DoubaoWebSocketLike

const defaultWebSocketFactory: DoubaoWebSocketFactory = (url, options) =>
  new WebSocket(url, options) as unknown as DoubaoWebSocketLike

export interface DoubaoProviderOptions {
  endpoint?: string
  webSocketFactory?: DoubaoWebSocketFactory
  requestIdFactory?: () => string
}

export class DoubaoProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = "DoubaoProviderError"
  }
}

export class DoubaoSttProvider implements StreamingSttProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: DoubaoProviderOptions = {}
  ) {}

  async createSession(
    sessionOptions: SttSessionOptions = {}
  ): Promise<StreamingSttSession> {
    const session = new DoubaoStreamingSttSession(this.apiKey, {
      ...this.options,
      requestOptions: sessionOptions,
    })
    await session.connect()
    return session
  }
}

interface SessionOptions extends DoubaoProviderOptions {
  requestOptions: SttSessionOptions
}

class EventQueue {
  private readonly events: SttEvent[] = []
  private readonly waiters: ((result: IteratorResult<SttEvent>) => void)[] = []
  private closed = false

  push(event: SttEvent): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: event, done: false })
      return
    }
    if (this.events.length >= MAX_PENDING_EVENTS) this.events.shift()
    this.events.push(event)
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0)
      this.waiters.shift()!({ value: undefined, done: true })
  }

  async *iterate(): AsyncIterable<SttEvent> {
    while (this.events.length > 0) yield this.events.shift()!
    while (!this.closed) {
      const next = await new Promise<IteratorResult<SttEvent>>((resolve) =>
        this.waiters.push(resolve)
      )
      if (next.done) return
      yield next.value
    }
  }
}

export class DoubaoStreamingSttSession implements StreamingSttSession {
  private readonly eventsQueue = new EventQueue()
  private readonly endpoint: string
  private readonly webSocketFactory: DoubaoWebSocketFactory
  private readonly requestIdFactory: () => string
  private socket: DoubaoWebSocketLike | null = null
  // Sequence 1 belongs to the initial request. Audio starts at 2; the
  // negative final packet uses the next unused sequence number.
  private sequence = 2
  private closed = false
  private closing = false
  private failed = false
  private closePromise?: Promise<void>
  private finalResponseResolve?: () => void
  private finalResponsePromise?: Promise<void>
  private speechOpen = false
  private pendingConnect:
    | {
        resolve: () => void
        reject: (error: DoubaoProviderError) => void
      }
    | undefined
  private readonly committed = new Set<string>()
  private readonly partials = new Map<string, string>()

  constructor(
    private readonly apiKey: string,
    options: SessionOptions
  ) {
    this.endpoint = options.endpoint ?? DOUBAO_ENDPOINT
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory
    this.requestIdFactory = options.requestIdFactory ?? (() => randomUUID())
    this.requestOptions = options.requestOptions
  }

  private readonly requestOptions: SttSessionOptions

  async connect(): Promise<void> {
    if (!this.apiKey)
      throw new DoubaoProviderError(
        "missing_api_key",
        "Doubao API key is required"
      )
    const headers = createDoubaoHeaders(this.apiKey, this.requestIdFactory())
    const requestOptions = this.requestOptionsFromOptions()
    const socket = this.webSocketFactory(this.endpoint, { headers })
    this.socket = socket
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settleResolve = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingConnect = undefined
          resolve()
        }
        const settleReject = (error: DoubaoProviderError): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.pendingConnect = undefined
          reject(error)
        }
        this.pendingConnect = { resolve: settleResolve, reject: settleReject }
        const timer = setTimeout(() => {
          if (settled) return
          const error = new DoubaoProviderError(
            "connect_timeout",
            "Doubao connection timed out",
            true
          )
          this.fail(error)
          settleReject(error)
        }, CONNECT_TIMEOUT_MS)
        socket.on("open", () => {
          if (settled) return
          try {
            socket.send(buildInitialRequest(requestOptions), (error) => {
              if (!error || settled) return
              const sendError = new DoubaoProviderError(
                "send_failed",
                "Doubao request could not be sent",
                true
              )
              this.fail(sendError)
              settleReject(sendError)
            })
          } catch {
            const error = new DoubaoProviderError(
              "send_failed",
              "Doubao request could not be sent",
              true
            )
            this.fail(error)
            settleReject(error)
          }
        })
        socket.on("message", (data: unknown) => this.handleMessage(data))
        socket.on("error", () => {
          if (!settled) {
            const error = new DoubaoProviderError(
              "connection_failed",
              "Doubao connection failed",
              true
            )
            this.fail(error)
            settleReject(error)
          } else
            this.fail(
              new DoubaoProviderError(
                "connection_lost",
                "Doubao connection lost",
                true
              )
            )
        })
        socket.on("close", () => {
          if (!settled) {
            const error = new DoubaoProviderError(
              "connection_closed",
              "Doubao connection closed",
              true
            )
            this.fail(error)
            settleReject(error)
          } else if (!this.closed && !this.closing) {
            this.fail(
              new DoubaoProviderError(
                "connection_closed",
                "Doubao connection closed",
                true
              )
            )
          }
        })
      })
    } catch (error) {
      this.closed = true
      this.socket?.terminate?.()
      this.socket?.close()
      this.eventsQueue.close()
      throw error
    }
  }

  private requestOptionsFromOptions(): DoubaoRequestOptions {
    const audio = this.requestOptions.audio as
      Record<string, unknown> | undefined
    return {
      uid:
        typeof this.requestOptions.uid === "string"
          ? this.requestOptions.uid
          : undefined,
      audio:
        audio && typeof audio === "object"
          ? {
              codec: audio.codec === "raw" ? "raw" : "opus",
              rate: typeof audio.rate === "number" ? audio.rate : undefined,
              channel:
                typeof audio.channel === "number" ? audio.channel : undefined,
              bits: typeof audio.bits === "number" ? audio.bits : undefined,
            }
          : undefined,
    }
  }

  async pushAudio(frame: AudioFrame): Promise<void> {
    if (this.closed || this.closing) return
    if (
      this.failed ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    )
      throw new DoubaoProviderError(
        "connection_unavailable",
        "Doubao connection is unavailable",
        true
      )
    if (frame.codec !== "opus" && frame.codec !== "pcm_s16le")
      throw new DoubaoProviderError(
        "unsupported_audio",
        "Doubao audio codec is unsupported"
      )
    try {
      await this.send(
        buildAudioRequest(this.sequence++, frame.data),
        "Doubao audio could not be sent"
      )
    } catch {
      const error = new DoubaoProviderError(
        "send_failed",
        "Doubao audio could not be sent",
        true
      )
      this.fail(error)
      throw error
    }
  }

  events(): AsyncIterable<SttEvent> {
    return this.eventsQueue.iterate()
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.closed) return
    this.closing = true
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    this.finalResponsePromise = new Promise<void>((resolve) => {
      this.finalResponseResolve = resolve
    })
    if (
      this.socket &&
      !this.failed &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      try {
        // Stop accepting audio before asking Doubao to finalize the stream,
        // but keep handleMessage alive during the bounded drain window so the
        // last definite result is still delivered to events().
        await this.send(
          buildAudioRequest(-this.sequence, new Uint8Array()),
          "Doubao final audio could not be sent"
        )
      } catch {
        // Closing is best effort; the session is already being torn down.
      }
      await Promise.race([
        this.finalResponsePromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, FINAL_DRAIN_TIMEOUT_MS)
        ),
      ])
    }
    this.closed = true
    this.eventsQueue.close()
    const socket = this.socket
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
        socket.on("close", () => {
          clearTimeout(timer)
          resolve()
        })
        socket.close()
      })
    }
  }

  private send(data: Buffer, failureMessage: string): Promise<void> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error(failureMessage))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(failureMessage))
      }, SEND_CALLBACK_TIMEOUT_MS)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      try {
        socket.send(data, finish)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(failureMessage))
      }
    })
  }

  private handleMessage(data: unknown): void {
    if (this.closed) return
    const frame = normalizeMessage(data)
    if (!frame) {
      this.fail(
        new DoubaoProviderError(
          "invalid_response",
          "Doubao returned an invalid response"
        )
      )
      return
    }
    let response: DoubaoResponse
    try {
      response = parseResponse(frame)
    } catch {
      this.fail(
        new DoubaoProviderError(
          "invalid_response",
          "Doubao returned an invalid response"
        )
      )
      return
    }
    if (response.code !== 0) {
      const error = new DoubaoProviderError(
        `provider_error_${response.code}`,
        "Doubao rejected the speech request"
      )
      this.fail(error)
      this.pendingConnect?.reject(error)
      return
    }
    this.pendingConnect?.resolve()
    for (const utterance of responseUtterances(response.payload))
      this.emitUtterance(utterance)
    if (response.isLastPackage) {
      this.finalResponseResolve?.()
      this.eventsQueue.close()
    }
  }

  private emitUtterance(utterance: DoubaoUtterance): void {
    const text = typeof utterance.text === "string" ? utterance.text : ""
    if (!text) return
    const start = numeric(utterance.start_time)
    const end = numeric(utterance.end_time)
    const key = `${start ?? "?"}:${end ?? "?"}`
    const timestampMs = end ?? start
    const definite = utterance.definite === true
    if (definite) {
      const identity = `${key}:${text}`
      if (this.committed.has(identity)) return
      this.committed.add(identity)
      this.partials.delete(key)
      if (!this.speechOpen) {
        this.eventsQueue.push({ type: "speech_started", timestampMs })
        this.speechOpen = true
      }
      this.eventsQueue.push({ type: "committed", text, timestampMs })
      this.eventsQueue.push({ type: "speech_ended", timestampMs })
      this.speechOpen = false
      return
    }
    if (this.partials.get(key) === text) return
    this.partials.set(key, text)
    if (!this.speechOpen) {
      this.eventsQueue.push({ type: "speech_started", timestampMs })
      this.speechOpen = true
    }
    this.eventsQueue.push({ type: "partial", text, timestampMs })
  }

  private fail(error: DoubaoProviderError): void {
    if (this.failed || this.closed) return
    this.failed = true
    this.pendingConnect?.reject(error)
    const event: SttError = {
      code: error.code,
      message: error.message,
      ...(error.retryable ? { retryable: true } : {}),
    }
    this.eventsQueue.push({ type: "error", error: event })
  }
}

function normalizeMessage(data: unknown): Uint8Array | undefined {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part)))
    return Buffer.concat(data)
  return undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
