import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises"
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
import { ModernMcpFree4ChatClient } from "./free4chat/modernClient.js"

export { runtimeDirectory, socketPath } from "./core/paths.js"

interface ResidentInstance {
  instanceId: string
  roomId: string
  runtime: ResidentRoomRuntime
}

// Fixed MIME→extension map (#111 review): local file extensions are never
// derived from remote-controlled MIME strings.
const SURFACE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
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
  op:
    | "join"
    | "create"
    | "status"
    | "leave"
    | "stop"
    | "reload-speech"
    | "update-capabilities"
    | "collab-request"
    | "collab-response"
    | "collab-result"
    | "attach"
    | "surface-publish"
    | "surface-clear"
    | "surface-read"
  room?: string
  name?: string
  agent?: string
  agentCommand?: string
  agentArgs?: string[]
  instanceId?: string
  capabilities?: string[]
  targetParticipantId?: string
  requestId?: string
  decision?: "accepted" | "declined"
  status?: "completed" | "failed"
  summary?: string
  details?: Record<string, string>
  attachmentIds?: string[]
  fileName?: string
  mimeType?: string
  dataBase64?: string
  sourceParticipantId?: string
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
    await removeStaleWorkspaces(join(runtimeDirectory(), "workspaces"))
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
    if (request.op === "join" || request.op === "create") {
      const isCreate = request.op === "create"
      if (isCreate) {
        if (!request.name) throw new Error("create requires name")
        if (request.room)
          throw new Error("create does not take a room; the room is generated")
      } else if (!request.room || !request.name) {
        throw new Error("join requires room and name")
      }
      if (request.agentCommand && request.agent)
        throw new Error("choose --agent or --agent-command, not both")
      if (!isCreate && !request.agent && !request.agentCommand)
        throw new Error("join requires agent or agent-command")
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
        ...(isCreate ? {} : { roomId: request.room }),
        name: request.name,
        capabilities:
          request.capabilities && request.capabilities.length > 0
            ? request.capabilities
            : undefined,
        client:
          process.env.FREE4CHAT_MCP_LEGACY === "1"
            ? new McpFree4ChatClient(mcpUrl)
            : new ModernMcpFree4ChatClient(mcpUrl),
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
        onRoomExpired: () => this.removeInstance(instanceId),
      })
      this.workspaces.set(instanceId, workspace)
      try {
        if (isCreate) {
          // Register the instance only after the create+adopt succeeded: a
          // failed startup leaves no ghost instance and performs best-effort
          // leave/close via stop() below. The returned payload carries
          // instance status and the PUBLIC invite — never handle/token.
          const created = await runtime.startByCreate()
          this.instances.set({
            instanceId,
            roomId: created.invite.roomId,
            runtime,
          })
          return { ...runtime.getStatus(), invite: created.invite }
        }
        this.instances.set({ instanceId, roomId: request.room!, runtime })
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
      return this.instances.values().map((instance) => ({
        ...instance.runtime.getStatus(),
        ...(instance.runtime.currentCapabilities().length > 0
          ? { capabilities: instance.runtime.currentCapabilities() }
          : {}),
      }))
    // #106 collaboration/capability operations: every one resolves the target
    // instance (explicit --instance, or the single resident instance) and
    // routes through the runtime, which owns the participant handle. The
    // Harness never sees the handle itself.
    if (
      request.op === "update-capabilities" ||
      request.op === "collab-request" ||
      request.op === "collab-response" ||
      request.op === "collab-result" ||
      request.op === "attach"
    ) {
      const runtime = this.resolveRuntime(request.instanceId)
      switch (request.op) {
        case "update-capabilities": {
          if (!request.capabilities)
            return {
              capabilities: runtime.currentCapabilities(),
            }
          await runtime.updateCapabilities(request.capabilities)
          return { capabilities: runtime.currentCapabilities() }
        }
        case "collab-request": {
          if (!request.targetParticipantId || !request.summary)
            throw new Error("collab request requires target and summary")
          return runtime.collabRequest({
            targetParticipantId: request.targetParticipantId,
            summary: request.summary,
            ...(request.requestId ? { requestId: request.requestId } : {}),
            ...(request.details ? { details: request.details } : {}),
            ...(request.attachmentIds && request.attachmentIds.length > 0
              ? { attachmentIds: request.attachmentIds }
              : {}),
          })
        }
        case "collab-response": {
          if (
            !request.requestId ||
            (request.decision !== "accepted" && request.decision !== "declined")
          )
            throw new Error("collab respond requires requestId and decision")
          return runtime.collabResponse(
            request.requestId,
            request.decision,
            request.summary
          )
        }
        case "collab-result": {
          if (
            !request.requestId ||
            (request.status !== "completed" && request.status !== "failed") ||
            !request.summary
          )
            throw new Error(
              "collab result requires requestId, status, and summary"
            )
          return runtime.collabResult({
            requestId: request.requestId,
            status: request.status,
            summary: request.summary,
            ...(request.details ? { details: request.details } : {}),
            ...(request.attachmentIds && request.attachmentIds.length > 0
              ? { attachmentIds: request.attachmentIds }
              : {}),
          })
        }
        case "attach": {
          if (!request.fileName || !request.mimeType || !request.dataBase64)
            throw new Error("attach requires file name, mime type, and data")
          // The uploaded attachment id is the whole point: a collaboration
          // result references it via --attach, so it must reach the caller.
          const uploaded = await runtime.uploadAttachment({
            fileName: request.fileName,
            mimeType: request.mimeType,
            dataBase64: request.dataBase64,
          })
          return { ok: true, attachment: uploaded }
        }
      }
    }
    if (request.op === "reload-speech") {
      // #105: speech setup completed out-of-band; hot-reload every resident
      // runtime's transcriber without touching room participants or leases.
      let reloaded = 0
      for (const instance of this.instances.values()) {
        try {
          if (await instance.runtime.reloadSpeech()) reloaded += 1
        } catch {
          // A failed reload keeps the previous (possibly absent) transcriber;
          // readiness remains the source of truth for the calling agent.
        }
      }
      return { ok: true, reloaded }
    }
    // #111 Observable Agent Workspace: publish/clear own surface; read a
    // peer's CURRENT snapshot (exact snapshotId from roster) into the
    // instance's Runtime-owned workspace. Handles never cross here.
    if (
      request.op === "surface-publish" ||
      request.op === "surface-clear" ||
      request.op === "surface-read"
    ) {
      const instanceIdResolved = request.instanceId ?? this.singleInstanceId()
      const runtime = this.resolveRuntime(instanceIdResolved)
      if (request.op === "surface-publish") {
        if (!request.mimeType || !request.dataBase64)
          throw new Error("surface publish requires mimeType and data")
        return runtime.publishSurface({
          mimeType: request.mimeType,
          dataBase64: request.dataBase64,
        })
      }
      if (request.op === "surface-clear") {
        await runtime.clearSurface()
        return { ok: true, cleared: true }
      }
      const sourceParticipantId = request.sourceParticipantId
      if (!sourceParticipantId)
        throw new Error("surface read requires --participant")
      // Pin the CURRENT snapshotId from roster metadata before bytes move;
      // a replace between metadata and read fails closed on mismatch.
      const current = runtime.peerSurface(sourceParticipantId)
      if (!current)
        throw new Error(
          "No workspace snapshot is currently published by that participant"
        )
      const read = await runtime.readSurface(
        sourceParticipantId,
        current.snapshotId
      )
      if (read.surface.snapshotId !== current.snapshotId)
        throw new Error("snapshot changed during read; retry")
      // Fixed MIME→extension map: never derive a local path component from
      // remote data. Decoded bytes must be non-empty, within the surface
      // bound, and EXACTLY metadata.size — otherwise nothing is written.
      const extension =
        SURFACE_EXTENSION_BY_MIME[read.surface.mimeType] ?? undefined
      if (!extension)
        throw new Error(`Unsupported surface MIME ${read.surface.mimeType}`)
      const decoded = Buffer.from(read.data, "base64")
      if (
        decoded.length === 0 ||
        decoded.length > 768 * 1024 ||
        decoded.length !== read.surface.size
      )
        throw new Error(
          "Surface payload failed size validation; no file was written"
        )
      const workspace =
        instanceIdResolved !== undefined
          ? this.workspaces.get(instanceIdResolved)
          : undefined
      if (!workspace) throw new Error("instance workspace unavailable")
      const surfacesDir = join(workspace, "surfaces")
      await mkdir(surfacesDir, { recursive: true, mode: 0o700 })
      const localPath = join(
        surfacesDir,
        `${read.surface.snapshotId}.${extension}`
      )
      await writeFile(localPath, Buffer.from(read.data, "base64"), {
        mode: 0o600,
      })
      return { surface: read.surface, localPath }
    }
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

  private singleInstanceId(): string | undefined {
    const all = this.instances.values()
    return all.length === 1 ? all[0].instanceId : undefined
  }

  private resolveRuntime(instanceId?: string): ResidentRoomRuntime {
    if (instanceId) {
      const instance = this.instances.get(instanceId)
      if (!instance)
        throw new Error(
          `No resident instance ${instanceId}. Run \`free4chat-agent status\`.`
        )
      return instance.runtime
    }
    const all = [...this.instances.values()]
    if (all.length !== 1)
      throw new Error(
        "Multiple or no resident instances; pass --instance <id> (see `free4chat-agent status`)"
      )
    return all[0].runtime
  }

  private async removeWorkspace(instanceId: string): Promise<void> {
    const workspace = this.workspaces.get(instanceId)
    if (!workspace) return
    this.workspaces.delete(instanceId)
    await rm(workspace, { recursive: true, force: true })
  }

  private async removeInstance(instanceId: string): Promise<void> {
    this.instances.delete(instanceId)
    await this.removeWorkspace(instanceId)
  }
}

/**
 * `ensureDaemon()` has already failed to reach the previous daemon before a
 * new one is spawned. Its per-instance workspaces are therefore stale; remove
 * them before accepting new joins so meeting transcripts cannot survive a
 * daemon crash indefinitely.
 */
export async function removeStaleWorkspaces(workspaces: string): Promise<void> {
  const entries = await readdir(workspaces, { withFileTypes: true })
  await Promise.all(
    entries.map((entry) =>
      rm(join(workspaces, entry.name), { recursive: true, force: true })
    )
  )
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
