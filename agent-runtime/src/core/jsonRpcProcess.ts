import { createInterface } from "node:readline"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { message?: string }
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

type NotificationListener = (notification: JsonRpcNotification) => void

export class JsonRpcProcess {
  private process?: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly listeners = new Set<NotificationListener>()
  private readonly notifications: JsonRpcNotification[] = []

  constructor(
    private readonly command: string,
    private readonly args: string[]
  ) {}

  start(): void {
    if (this.process) return
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    this.process = child
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => this.handleLine(line))
    child.stderr.resume()
    child.once("error", (error) => this.failAll(error))
    child.once("exit", (code, signal) => {
      this.process = undefined
      this.failAll(
        new Error(`${this.command} exited (${code ?? signal ?? "unknown"})`)
      )
    })
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse & Partial<JsonRpcNotification>
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id)
      if (!request) {
        if (message.method && this.process?.stdin)
          this.process.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32001,
                message: "Approval is not available in the local runtime",
              },
            })}\n`
          )
        return
      }
      this.pending.delete(message.id)
      if (message.error)
        request.reject(new Error(message.error.message ?? "JSON-RPC error"))
      else request.resolve(message.result)
      return
    }
    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params }
      if (this.listeners.size > 0) {
        for (const listener of this.listeners) listener(notification)
      } else {
        this.notifications.push(notification)
        while (this.notifications.length > 100) this.notifications.shift()
      }
    }
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    this.start()
    const child = this.process
    if (!child?.stdin)
      return Promise.reject(new Error(`${this.command} is not running`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
        )
      } catch (error) {
        this.pending.delete(id)
        reject(
          error instanceof Error ? error : new Error("JSON-RPC write failed")
        )
      }
    })
  }

  waitForNotification(
    predicate: (notification: JsonRpcNotification) => boolean,
    timeoutMs = 15 * 60_000
  ): Promise<JsonRpcNotification> {
    const existing = this.notifications.find(predicate)
    if (existing) {
      this.notifications.splice(this.notifications.indexOf(existing), 1)
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener)
        reject(new Error("JSON-RPC notification timed out"))
      }, timeoutMs)
      const listener = (notification: JsonRpcNotification) => {
        if (!predicate(notification)) return
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(notification)
      }
      this.listeners.add(listener)
    })
  }

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  async close(): Promise<void> {
    const child = this.process
    this.process = undefined
    if (!child) return
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => child.once("close", () => resolve()))
  }
}
