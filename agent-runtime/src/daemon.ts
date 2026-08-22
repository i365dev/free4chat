import { chmod, mkdir, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

import { createHarnessAdapter } from "./adapters/index.js"
import { ResidentRoomRuntime } from "./core/runtime.js"
import { McpFree4ChatClient } from "./free4chat/client.js"
import type { AgentAdapterName } from "./types.js"

export function runtimeDirectory(): string {
  return process.env.FREE4CHAT_AGENT_DIR || join(homedir(), ".free4chat-agent")
}

export function socketPath(): string {
  return join(runtimeDirectory(), "daemon.sock")
}

interface IpcRequest {
  op: "join" | "status" | "leave" | "stop"
  room?: string
  name?: string
  adapter?: AgentAdapterName
}

export class AgentDaemon {
  private readonly rooms = new Map<string, ResidentRoomRuntime>()
  private server?: ReturnType<typeof createServer>

  async start(): Promise<void> {
    await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 })
    await chmod(runtimeDirectory(), 0o700)
    await rm(socketPath(), { force: true })
    this.server = createServer((socket) => this.handleSocket(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject)
      this.server!.listen(socketPath(), () => resolve())
    })
    await chmod(socketPath(), 0o600)
    await new Promise<void>((resolve) => {
      this.server!.once("close", () => resolve())
    })
  }

  private handleSocket(socket: Socket): void {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void this.handleRequest(socket, line)
        newline = buffer.indexOf("\n")
      }
    })
  }

  private async handleRequest(socket: Socket, line: string): Promise<void> {
    try {
      const request = JSON.parse(line) as IpcRequest
      const result = await this.dispatch(request)
      socket.end(`${JSON.stringify({ ok: true, result })}\n`)
    } catch (error) {
      socket.end(
        `${JSON.stringify({
          ok: false,
          error:
            error instanceof Error ? error.message : "daemon request failed",
        })}\n`
      )
    }
  }

  private async dispatch(request: IpcRequest): Promise<unknown> {
    if (request.op === "join") {
      if (!request.room || !request.name || !request.adapter)
        throw new Error("join requires room, name, and adapter")
      if (this.rooms.has(request.room))
        return this.rooms.get(request.room)!.getStatus()
      const runtime = new ResidentRoomRuntime({
        roomId: request.room,
        name: request.name,
        client: new McpFree4ChatClient(),
        adapter: createHarnessAdapter(request.adapter),
      })
      this.rooms.set(request.room, runtime)
      try {
        await runtime.start()
      } catch (error) {
        this.rooms.delete(request.room)
        await runtime.stop().catch(() => undefined)
        throw error
      }
      return runtime.getStatus()
    }
    if (request.op === "status")
      return [...this.rooms.values()].map((room) => room.getStatus())
    if (request.op === "leave") {
      if (!request.room) throw new Error("leave requires room")
      const runtime = this.rooms.get(request.room)
      if (runtime) {
        this.rooms.delete(request.room)
        await runtime.stop()
      }
      return { room: request.room, state: "stopped" }
    }
    if (request.op === "stop") {
      for (const runtime of this.rooms.values()) await runtime.stop()
      this.rooms.clear()
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
      return { state: "stopped" }
    }
    throw new Error("unknown daemon operation")
  }
}

async function waitForSocket(timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await sendIpc({ op: "status" })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error("free4chat-agent daemon did not start")
}

export async function ensureDaemon(): Promise<void> {
  try {
    await sendIpc({ op: "status" })
    return
  } catch {
    const child = spawn(process.execPath, [process.argv[1], "daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()
    await waitForSocket()
  }
}

export async function sendIpc(request: IpcRequest): Promise<unknown> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath())
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const response = JSON.parse(buffer.slice(0, newline)) as {
        ok: boolean
        result?: unknown
        error?: string
      }
      socket.end()
      if (response.ok) resolve(response.result)
      else reject(new Error(response.error || "daemon request failed"))
    })
    socket.once("error", reject)
    socket.write(`${JSON.stringify(request)}\n`)
  })
}
