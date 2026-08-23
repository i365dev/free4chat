import { chmod, mkdir, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

import {
  AcpHarnessAdapter,
  customLauncher,
  getLauncher,
} from "./adapters/index.js"
import { ResidentRoomRuntime } from "./core/runtime.js"
import { InstanceRegistry } from "./core/instanceRegistry.js"
import { runtimeDirectory, socketPath } from "./core/paths.js"
import { McpFree4ChatClient } from "./free4chat/client.js"

export { runtimeDirectory, socketPath } from "./core/paths.js"

interface ResidentInstance {
  instanceId: string
  roomId: string
  runtime: ResidentRoomRuntime
}

function optionalMilliseconds(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 1)
    throw new Error(`${name} must be a positive number of milliseconds`)
  return Math.floor(value)
}

export interface IpcRequest {
  op: "join" | "status" | "leave" | "stop"
  room?: string
  name?: string
  agent?: string
  agentCommand?: string
  agentArgs?: string[]
  instanceId?: string
}

export class AgentDaemon {
  private readonly instances = new InstanceRegistry<ResidentInstance>()
  private readonly workspaces = new Map<string, string>()
  private server?: ReturnType<typeof createServer>

  async start(): Promise<void> {
    await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 })
    await chmod(runtimeDirectory(), 0o700)
    await mkdir(join(runtimeDirectory(), "workspaces"), {
      recursive: true,
      mode: 0o700,
    })
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
      const result = await this.dispatch(JSON.parse(line) as IpcRequest)
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
      if (!request.room || !request.name)
        throw new Error("join requires room and name")
      if (request.agentCommand && request.agent)
        throw new Error("choose --agent or --agent-command, not both")
      const launcher = request.agentCommand
        ? customLauncher(request.agentCommand, request.agentArgs ?? [])
        : getLauncher(request.agent ?? "")
      const turnTimeoutMs = optionalMilliseconds(
        "FREE4CHAT_ACP_TURN_TIMEOUT_MS"
      )
      const cancelGraceMs = optionalMilliseconds(
        "FREE4CHAT_ACP_CANCEL_GRACE_MS"
      )
      const instanceId = randomUUID()
      const workspace = join(runtimeDirectory(), "workspaces", instanceId)
      await mkdir(workspace, { recursive: true, mode: 0o700 })
      const mcpUrl =
        process.env.FREE4CHAT_MCP_URL ?? "https://www.free4.chat/mcp"
      const runtime = new ResidentRoomRuntime({
        instanceId,
        roomId: request.room,
        name: request.name,
        client: new McpFree4ChatClient(mcpUrl),
        adapter: new AcpHarnessAdapter(launcher, workspace, {
          turnTimeoutMs,
          cancelGraceMs,
        }),
        mcpUrl,
        // Every join gets a fresh UUID workspace, and the transcript lives in
        // a hidden child directory inside it. The workspace is never reused
        // across rooms, so one resident Agent cannot leak speech memory from
        // one room into another.
        transcriptPath: join(workspace, ".meeting-notes", "transcript.jsonl"),
      })
      this.instances.set({ instanceId, roomId: request.room, runtime })
      this.workspaces.set(instanceId, workspace)
      try {
        await runtime.start()
      } catch (error) {
        this.instances.delete(instanceId)
        await runtime.stop().catch(() => undefined)
        await this.removeWorkspace(instanceId)
        throw error
      }
      return runtime.getStatus()
    }
    if (request.op === "status")
      return this.instances
        .values()
        .map((instance) => instance.runtime.getStatus())
    if (request.op === "leave") {
      if (!request.instanceId) throw new Error("leave requires instanceId")
      const instance = this.instances.get(request.instanceId)
      if (!instance) return { instanceId: request.instanceId, state: "stopped" }
      this.instances.delete(request.instanceId)
      await instance.runtime.stop()
      await this.removeWorkspace(request.instanceId)
      return { instanceId: request.instanceId, state: "stopped" }
    }
    if (request.op === "stop") {
      for (const instance of this.instances.values()) {
        await instance.runtime.stop()
        const instanceId = instance.instanceId
        await this.removeWorkspace(instanceId)
      }
      for (const instance of this.instances.values())
        this.instances.delete(instance.instanceId)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()))
      return { state: "stopped" }
    }
    throw new Error("unknown daemon operation")
  }

  private async removeWorkspace(instanceId: string): Promise<void> {
    const workspace = this.workspaces.get(instanceId)
    if (!workspace) return
    this.workspaces.delete(instanceId)
    await rm(workspace, { recursive: true, force: true })
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
