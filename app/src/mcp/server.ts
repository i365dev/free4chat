import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server"
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server"
import { z } from "zod"

import type { RoomSession } from "../do/RoomSession"

const MAX_ROOM_LENGTH = 64
const MAX_NAME_LENGTH = 32
const MAX_TEXT_LENGTH = 4000
const JOIN_RATE_LIMIT = 10
const JOIN_RATE_WINDOW_S = 60

const MCP_HOSTNAMES = [
  "free4.chat",
  "www.free4.chat",
  "localhost",
  "127.0.0.1",
  "[::1]",
]

export interface McpEnv {
  SFU_ROOM: DurableObjectNamespace<RoomSession>
  ROOMS_KV: KVNamespace
}

interface AgentHandle {
  room: string
  participantId: string
  participantToken: string
}

interface ControlResult {
  ok: boolean
  status: number
  data: Record<string, unknown>
}

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  }
}

function toolError(error: string) {
  return toolResult({ error }, true)
}

function imageToolResult(
  image: { data: string; mimeType: string },
  metadata: unknown
) {
  return {
    content: [
      { type: "image" as const, data: image.data, mimeType: image.mimeType },
      { type: "text" as const, text: JSON.stringify(metadata) },
    ],
  }
}

function encodeHandle(handle: AgentHandle): string {
  const bytes = new TextEncoder().encode(JSON.stringify(handle))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function decodeHandle(value: string): AgentHandle | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    )
    const candidate = JSON.parse(
      new TextDecoder().decode(bytes)
    ) as Partial<AgentHandle>
    if (
      typeof candidate.room !== "string" ||
      typeof candidate.participantId !== "string" ||
      typeof candidate.participantToken !== "string" ||
      !candidate.room ||
      !candidate.participantId ||
      !candidate.participantToken ||
      candidate.room.length > MAX_ROOM_LENGTH
    )
      return null
    return {
      room: candidate.room,
      participantId: candidate.participantId,
      participantToken: candidate.participantToken,
    }
  } catch {
    return null
  }
}

function envFromAuthContext(): McpEnv {
  const candidate = getMcpAuthContext()?.props.env
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("SFU_ROOM" in candidate) ||
    !("ROOMS_KV" in candidate)
  ) {
    throw new Error("MCP environment is unavailable")
  }
  return candidate as McpEnv
}

async function roomControl(
  env: McpEnv,
  room: string,
  body: Record<string, unknown>
): Promise<ControlResult> {
  const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(room))
  const response = await stub.fetch("https://room/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  return { ok: response.ok, status: response.status, data }
}

function controlError(result: ControlResult): string {
  if (result.data.error === "room_expired") return "room_expired"
  if (result.data.error === "already_left") return "already_left"
  if (result.data.error === "wait_already_pending")
    return "wait_already_pending"
  if (result.data.error === "attachment_unavailable")
    return "attachment_unavailable"
  if (result.status === 401) return "invalid_participant_handle"
  if (result.status === 403) return "agent_only"
  return "room_unavailable"
}

async function allowJoin(
  env: McpEnv,
  request: Request | undefined
): Promise<boolean> {
  const ip = request?.headers.get("CF-Connecting-IP") || "unknown"
  const key = `mcp:join:rl:${ip}`
  const raw = await env.ROOMS_KV.get(key)
  const count = raw ? Number.parseInt(raw, 10) : 0
  if (count >= JOIN_RATE_LIMIT) return false
  await env.ROOMS_KV.put(key, String(count + 1), {
    expirationTtl: JOIN_RATE_WINDOW_S,
  })
  return true
}

function createMcpServer(context: McpRequestContext) {
  const env = envFromAuthContext()
  const server = new McpServer({
    name: "free4chat-agent-room",
    version: "1.0.0",
  })

  server.registerTool(
    "room_info",
    {
      description:
        "Inspect a Free4Chat room without joining. Returns sanitized participants and capabilities, never room history or media identifiers.",
      inputSchema: {
        roomId: z.string().trim().min(1).max(MAX_ROOM_LENGTH),
      },
    },
    async ({ roomId }) => {
      const result = await roomControl(env, roomId, { action: "room-info" })
      return result.ok ? toolResult(result.data) : toolError("room_unavailable")
    }
  )

  server.registerTool(
    "join_room",
    {
      description:
        "Join a Free4Chat room as a text-only Agent. The returned participant handle is a capability and must be kept private.",
      inputSchema: {
        roomId: z.string().trim().min(1).max(MAX_ROOM_LENGTH),
        name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
      },
    },
    async ({ roomId, name }) => {
      if (!(await allowJoin(env, context.requestInfo)))
        return toolError("rate_limited")
      const participantId = crypto.randomUUID()
      const participantToken = crypto.randomUUID()
      const result = await roomControl(env, roomId, {
        action: "agent-register",
        participant: {
          id: participantId,
          name,
          kind: "agent",
          joinedAt: Date.now(),
          token: participantToken,
          capabilities: { text: true },
        },
      })
      if (!result.ok) return toolError(controlError(result))
      return toolResult({
        participant: result.data.participant,
        participantHandle: encodeHandle({
          room: roomId,
          participantId,
          participantToken,
        }),
        cursor: result.data.cursor,
        expiresAt: result.data.expiresAt,
      })
    }
  )

  server.registerTool(
    "wait_for_events",
    {
      description:
        "Wait for new text, action, or image events in the room. All room events are visible for context; addressed is true only when a message targets this Agent.",
      inputSchema: {
        participantHandle: z.string().min(1),
        cursor: z.number().int().min(0).default(0),
        timeoutSeconds: z.number().int().min(0).max(25).default(20),
      },
    },
    async ({ participantHandle, cursor, timeoutSeconds }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-wait",
        participantId: handle.participantId,
        token: handle.participantToken,
        cursor,
        timeoutSeconds,
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(controlError(result))
    }
  )

  server.registerTool(
    "send_text",
    {
      description: "Send one text message to the room as the joined Agent.",
      inputSchema: {
        participantHandle: z.string().min(1),
        text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
      },
    },
    async ({ participantHandle, text }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-send-text",
        participantId: handle.participantId,
        token: handle.participantToken,
        text,
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(controlError(result))
    }
  )

  server.registerTool(
    "read_attachment",
    {
      description:
        "Read an ephemeral image attachment from this Agent's current Free4Chat room. Returns official MCP ImageContent; use only when relevant.",
      inputSchema: {
        participantHandle: z.string().min(1),
        attachmentId: z.string().uuid(),
      },
    },
    async ({ participantHandle, attachmentId }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-read-attachment",
        participantId: handle.participantId,
        token: handle.participantToken,
        attachmentId,
      })
      if (!result.ok) return toolError(controlError(result))
      const data = result.data.data
      const attachment = result.data.attachment
      if (
        typeof data !== "string" ||
        !attachment ||
        typeof attachment !== "object" ||
        typeof (attachment as { mimeType?: unknown }).mimeType !== "string"
      )
        return toolError("attachment_unavailable")
      return imageToolResult(
        {
          data,
          mimeType: (attachment as { mimeType: string }).mimeType,
        },
        attachment
      )
    }
  )

  server.registerTool(
    "leave_room",
    {
      description:
        "Leave the room and invalidate the Agent participant handle.",
      inputSchema: {
        participantHandle: z.string().min(1),
      },
    },
    async ({ participantHandle }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-leave",
        participantId: handle.participantId,
        token: handle.participantToken,
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(controlError(result))
    }
  )

  return server
}

export function handleMcpRequest(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const handler = createMcpHandler(createMcpServer, {
    route: "/mcp",
    allowedHostnames: MCP_HOSTNAMES,
    allowedOriginHostnames: MCP_HOSTNAMES,
    // CORS response headers are broad for browser-based MCP inspectors; the
    // explicit origin allowlist above still rejects untrusted browser Origins.
    corsOptions: {
      origin: "*",
      methods: "POST, OPTIONS",
      headers: "Content-Type, Accept, MCP-Protocol-Version",
      maxAge: 86400,
    },
    legacy: "reject",
    responseMode: "json",
    authContext: { props: { env } },
  })
  return handler(request, env, ctx)
}
