import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server"
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server"
import { z } from "zod"

import { buildRoomInvite } from "./invite"
import { imageToolResult } from "./toolResults"
import type { RoomSession } from "../do/RoomSession"

const MAX_ROOM_LENGTH = 64
const MAX_NAME_LENGTH = 32
const MAX_TEXT_LENGTH = 4000
// #106 Phase A/B bounds mirrored from do/collab.ts so MCP clients get
// fast, local shape errors before the DO rejects them anyway.
const MAX_CAPABILITIES = 8
const MAX_CAPABILITY_LENGTH = 48
const MAX_COLLAB_SUMMARY_LENGTH = 1200
const MAX_COLLAB_ATTACHMENT_REFS = 3
const MAX_ATTACHMENT_BASE64 = 1400_000
// #165: mirrored from do/RoomSession.ts MAX_TARGETS — the same bound the DO
// applies when persisting addressed text targets.
const MAX_TARGETS = 8
const MAX_TARGET_ID_LENGTH = 64
const JOIN_RATE_LIMIT = 10
const JOIN_RATE_WINDOW_S = 60
// #176 Phase A: mirrored from do/collab.ts — the Runtime Host projection is
// an opaque bounded id plus coarse speech booleans, nothing else.
const runtimeHostSchema = z.object({
  runtimeHostId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{8,64}$/),
  speech: z.object({ stt: z.boolean(), tts: z.boolean() }),
})
// 256-bit base64url opaque capability values. The MCP boundary validates the
// shape but never logs, projects, or includes either value in room_info.
const runtimeProviderCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

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
  if (typeof result.data.error === "string") {
    const error = result.data.error
    if (error.startsWith("surface_")) return error
  }
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
        "Inspect a Free4Chat room without joining. Returns sanitized participants, capabilities, and the bounded shared Live Transcript context when present; never ordinary room history, provider proof, or media identifiers.",
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
        "Join a Free4Chat room as a text-only Agent. The returned participant handle is a capability and must be kept private. Optionally advertise a small, honest list of capability tokens (e.g. code.edit, browser.authenticated) that describe what you may be able to do for THIS room — descriptions only, never authorization.",
      inputSchema: {
        roomId: z.string().trim().min(1).max(MAX_ROOM_LENGTH),
        name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
        capabilities: z
          .array(z.string().trim().min(1).max(MAX_CAPABILITY_LENGTH))
          .max(MAX_CAPABILITIES)
          .optional(),
        runtimeHost: runtimeHostSchema.optional(),
        providerClaimHash: runtimeProviderCredentialSchema.optional(),
        runtimeProviderHandle: runtimeProviderCredentialSchema.optional(),
      },
    },
    async ({
      roomId,
      name,
      capabilities,
      runtimeHost,
      providerClaimHash,
      runtimeProviderHandle,
    }) => {
      if (!(await allowJoin(env, context.requestInfo)))
        return toolError("rate_limited")
      const participantId = crypto.randomUUID()
      const participantToken = crypto.randomUUID()
      const normalized = (capabilities ?? []).map((capability) =>
        capability.trim().toLowerCase()
      )
      const result = await roomControl(env, roomId, {
        action: "agent-register",
        participant: {
          id: participantId,
          name,
          kind: "agent",
          joinedAt: Date.now(),
          token: participantToken,
          capabilities: {
            text: true,
            ...(normalized.length > 0 ? { advertised: normalized } : {}),
          },
          ...(runtimeHost ? { runtimeHost } : {}),
          ...(providerClaimHash ? { providerClaimHash } : {}),
          ...(runtimeProviderHandle ? { runtimeProviderHandle } : {}),
        },
      })
      if (!result.ok)
        return toolError(
          result.data.error === "invalid_capabilities"
            ? "invalid_capabilities"
            : controlError(result)
        )
      const returnedProviderHandle = runtimeProviderCredentialSchema.safeParse(
        result.data.runtimeProviderHandle
      )
      if (
        result.data.runtimeProviderHandle !== undefined &&
        returnedProviderHandle.success === false
      )
        return toolError("runtime_provider_handle_invalid")
      return toolResult({
        participant: result.data.participant,
        participantHandle: encodeHandle({
          room: roomId,
          participantId,
          participantToken,
        }),
        cursor: result.data.cursor,
        expiresAt: result.data.expiresAt,
        ...(returnedProviderHandle.success
          ? { runtimeProviderHandle: returnedProviderHandle.data }
          : {}),
      })
    }
  )

  server.registerTool(
    "create_room",
    {
      description:
        "Create a fresh temporary Free4Chat room and join it as the first Agent participant (#51). The creator has no owner/admin authority — the room is ordinary. Returns your private participant handle (keep secret) plus a small public invite descriptor (kind/version/roomId/roomUrl) you may hand to another Agent or Human through any existing channel. Delivery is not provided; Free4Chat is not a discovery service.",
      inputSchema: {
        name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
        capabilities: z
          .array(z.string().trim().min(1).max(MAX_CAPABILITY_LENGTH))
          .max(MAX_CAPABILITIES)
          .optional(),
      },
    },
    async ({ name, capabilities }) => {
      // #178 review fix 3: create_room NEVER accepts a runtimeHost — the
      // Room-scoped id is derived from the final server-generated roomId,
      // which does not exist at call time. Obtain the roomId here, then
      // call update_runtime_host.
      void runtimeHostSchema
      // Same per-IP budget as joining: creation is one join-shaped
      // admission, not an unbounded resource.
      if (!(await allowJoin(env, context.requestInfo)))
        return toolError("rate_limited")
      const participantId = crypto.randomUUID()
      const participantToken = crypto.randomUUID()
      const normalized = (capabilities ?? []).map((capability) =>
        capability.trim().toLowerCase()
      )
      // Bounded retry with fresh cryptographic ids; the DO itself is
      // strictly create-only, so a collision can never join or mutate an
      // existing room and no old invite can be repointed at a new generation.
      let created: Record<string, unknown> | null = null
      let roomId = ""
      for (let attempt = 0; attempt < 3; attempt += 1) {
        roomId = crypto.randomUUID()
        const result = await roomControl(env, roomId, {
          action: "agent-create-room",
          participant: {
            id: participantId,
            name,
            kind: "agent",
            joinedAt: Date.now(),
            token: participantToken,
            capabilities: {
              text: true,
              ...(normalized.length > 0 ? { advertised: normalized } : {}),
            },
          },
        })
        if (result.ok) {
          created = result.data as Record<string, unknown>
          break
        }
        if (result.data.error === "room_already_exists") continue
        return toolError(
          result.data.error === "invalid_capabilities"
            ? "invalid_capabilities"
            : controlError(result)
        )
      }
      if (!created) return toolError("room_id_collision")
      const payload = created as {
        participant?: unknown
        cursor?: unknown
        expiresAt?: unknown
      }
      return toolResult({
        participant: payload.participant,
        participantHandle: encodeHandle({
          room: roomId,
          participantId,
          participantToken,
        }),
        cursor: payload.cursor,
        expiresAt: payload.expiresAt,
        invite: buildRoomInvite(roomId),
      })
    }
  )

  server.registerTool(
    "update_capabilities",
    {
      description:
        "Replace this Agent's advertised capability list for the room. Advertised capabilities are discovery descriptions chosen by you — never authorization grants, never visible to humans as promises. Keep the list small and honest for this room.",
      inputSchema: {
        participantHandle: z.string().min(1),
        capabilities: z
          .array(z.string().trim().min(1).max(MAX_CAPABILITY_LENGTH))
          .max(MAX_CAPABILITIES),
      },
    },
    async ({ participantHandle, capabilities }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-update-capabilities",
        participantId: handle.participantId,
        token: handle.participantToken,
        capabilities: capabilities.map((capability) =>
          capability.trim().toLowerCase()
        ),
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(
            result.data.error === "invalid_capabilities"
              ? "invalid_capabilities"
              : controlError(result)
          )
    }
  )

  server.registerTool(
    "update_runtime_host",
    {
      description:
        "Re-project this Agent's Runtime Host capability projection (#176): the stable opaque, Room-scoped runtimeHostId your local Runtime derived for this Room plus coarse speech readiness (stt/tts booleans). One readiness is shared by all same-host Agents. Discovery metadata only — never authorization, never credential details. Call after a local speech configuration change (e.g. credential provision) so the Room updates without rejoining.",
      inputSchema: {
        participantHandle: z.string().min(1),
        runtimeHost: runtimeHostSchema,
        runtimeProviderHandle: runtimeProviderCredentialSchema.optional(),
      },
    },
    async ({ participantHandle, runtimeHost, runtimeProviderHandle }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-update-runtime-host",
        participantId: handle.participantId,
        token: handle.participantToken,
        runtimeHost,
        ...(runtimeProviderHandle ? { runtimeProviderHandle } : {}),
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(
            typeof result.data.error === "string"
              ? result.data.error
              : controlError(result)
          )
    }
  )

  server.registerTool(
    "wait_for_events",
    {
      description:
        "Wait for new text, action, image, and collaboration events in the room. All room events are visible for context; addressed is true only when a message targets this Agent. The response also carries a compact connected-participant projection with advertised capability tokens for discovery.",
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
      description:
        "Send one text message to the room as the joined Agent. Optionally pass explicit target participant IDs (from room_info/wait_for_events roster metadata) to address the message: every participant still sees it as room context, but only targeted Agents receive it as a new addressed turn. Targeting decides attention only — never authorization. Plain text without targets stays an ordinary unaddressed message.",
      inputSchema: {
        participantHandle: z.string().min(1),
        text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
        targetParticipantIds: z
          .array(z.string().trim().min(1).max(MAX_TARGET_ID_LENGTH))
          .max(MAX_TARGETS)
          .optional(),
      },
    },
    async ({ participantHandle, text, targetParticipantIds }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-send-text",
        participantId: handle.participantId,
        token: handle.participantToken,
        text,
        ...(targetParticipantIds?.length ? { targetParticipantIds } : {}),
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(controlError(result))
    }
  )

  const collabDetailsSchema = z
    .record(z.string(), z.string().max(512))
    .optional()
  const attachmentRefsSchema = z
    .array(z.string().uuid())
    .max(MAX_COLLAB_ATTACHMENT_REFS)
    .optional()

  server.registerTool(
    "send_collab_request",
    {
      description:
        "Send a structured work request to another room participant (#106). Collaboration intent only — the target decides autonomously whether to accept. Returns the requestId used for correlated responses.",
      inputSchema: {
        participantHandle: z.string().min(1),
        targetParticipantId: z.string().min(1),
        summary: z.string().trim().min(1).max(MAX_COLLAB_SUMMARY_LENGTH),
        requestId: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/)
          .optional(),
        details: collabDetailsSchema,
        attachmentIds: attachmentRefsSchema,
      },
    },
    async ({
      participantHandle,
      targetParticipantId,
      summary,
      requestId,
      details,
      attachmentIds,
    }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-send-collab",
        participantId: handle.participantId,
        token: handle.participantToken,
        event: {
          kind: "request",
          ...(requestId ? { requestId } : {}),
          targetParticipantId,
          summary,
          ...(details ? { details } : {}),
          ...(attachmentIds ? { attachmentIds } : {}),
        },
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(
            typeof result.data.error === "string"
              ? result.data.error
              : controlError(result)
          )
    }
  )

  server.registerTool(
    "send_collab_response",
    {
      description:
        "Answer a collaboration request addressed to you with accepted or declined (#106). Only the request's target can respond; correlation is enforced by requestId.",
      inputSchema: {
        participantHandle: z.string().min(1),
        requestId: z.string().min(1).max(64),
        decision: z.enum(["accepted", "declined"]),
        summary: z.string().trim().max(MAX_COLLAB_SUMMARY_LENGTH).optional(),
      },
    },
    async ({ participantHandle, requestId, decision, summary }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-send-collab",
        participantId: handle.participantId,
        token: handle.participantToken,
        event: {
          kind: decision,
          requestId,
          ...(summary ? { summary } : {}),
        },
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(
            typeof result.data.error === "string"
              ? result.data.error
              : controlError(result)
          )
    }
  )

  server.registerTool(
    "send_collab_result",
    {
      description:
        "Return the terminal structured outcome of a collaboration request you handled: completed or failed (#106). May reference existing room attachments (e.g. a screenshot you uploaded via send_attachment) as artifacts.",
      inputSchema: {
        participantHandle: z.string().min(1),
        requestId: z.string().min(1).max(64),
        status: z.enum(["completed", "failed"]),
        summary: z.string().trim().min(1).max(MAX_COLLAB_SUMMARY_LENGTH),
        details: collabDetailsSchema,
        attachmentIds: attachmentRefsSchema,
      },
    },
    async ({
      participantHandle,
      requestId,
      status,
      summary,
      details,
      attachmentIds,
    }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-send-collab",
        participantId: handle.participantId,
        token: handle.participantToken,
        event: {
          kind: status,
          requestId,
          summary,
          ...(details ? { details } : {}),
          ...(attachmentIds ? { attachmentIds } : {}),
        },
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(
            typeof result.data.error === "string"
              ? result.data.error
              : controlError(result)
          )
    }
  )

  server.registerTool(
    "send_attachment",
    {
      description:
        "Upload one bounded ephemeral file (image jpeg/png/webp or text-like plain/markdown/csv/json/yaml, ≤768KB) into this Agent's current room so other participants can read it via read_attachment (#106 artifact path). Same store, limits, and eviction as human uploads; never persisted beyond the room.",
      inputSchema: {
        participantHandle: z.string().min(1),
        fileName: z.string().trim().min(1).max(256),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/webp",
          "text/plain",
          "text/markdown",
          "text/csv",
          "application/json",
          "text/yaml",
        ]),
        dataBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64),
      },
    },
    async ({ participantHandle, fileName, mimeType, dataBase64 }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      let bytes: Uint8Array<ArrayBuffer>
      try {
        const padded = dataBase64.replaceAll("-", "+").replaceAll("_", "/")
        const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
        bytes = new Uint8Array(new ArrayBuffer(binary.length))
        for (let index = 0; index < binary.length; index += 1)
          bytes[index] = binary.charCodeAt(index)
      } catch {
        return toolError("invalid_attachment")
      }
      const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(handle.room))
      const response = await stub.fetch("https://room/attachment", {
        method: "POST",
        headers: {
          "Content-Type": mimeType,
          "X-Room-Participant-Id": handle.participantId,
          "X-Room-Participant-Token": handle.participantToken,
          "X-File-Name": encodeURIComponent(fileName),
        },
        body: bytes,
      })
      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >
      return response.ok
        ? toolResult(data)
        : toolError(
            typeof data.error === "string"
              ? data.error
              : "attachment_unavailable"
          )
    }
  )

  server.registerTool(
    "read_attachment",
    {
      description:
        "Read one ephemeral attachment from this Agent's current Free4Chat room. Images return official MCP ImageContent; supported text-like attachments return decoded UTF-8 text. Use only when relevant.",
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
      const mimeType = (attachment as { mimeType: string }).mimeType
      if (
        mimeType === "text/plain" ||
        mimeType === "text/markdown" ||
        mimeType === "text/csv" ||
        mimeType === "application/json" ||
        mimeType === "text/yaml"
      ) {
        // Text-like attachments come back inside the same JSON envelope as
        // every other tool result, with `text` carrying the decoded UTF-8
        // content so Harness-side vision is not required to consume them.
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
        let text: string
        try {
          text = new TextDecoder().decode(bytes)
        } catch {
          return toolError("attachment_unavailable")
        }
        return toolResult({ attachment, data, text })
      }
      return imageToolResult({ data, mimeType }, attachment)
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

  // #111 Observable Agent Workspace v0: opt-in, Agent-only, own-surface-only
  // ephemeral snapshot. Metadata is public room state; bytes are readable
  // only by current participants with the exact current snapshotId.
  const SURFACE_MIME = z.enum(["image/jpeg", "image/png", "image/webp"])

  server.registerTool(
    "publish_surface",
    {
      description:
        "Publish/replace your single latest workspace snapshot image (jpeg/png/webp, ≤768KB). Explicitly participant-controlled observation — never automatic capture, never a live stream, and never authorization for anyone to control your machine. The server assigns the new snapshotId; the previous snapshot is destroyed.",
      inputSchema: {
        participantHandle: z.string().min(1),
        mimeType: SURFACE_MIME,
        dataBase64: z.string().min(1).max(1_400_000),
      },
    },
    async ({ participantHandle, mimeType, dataBase64 }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      let bytes: Uint8Array<ArrayBuffer>
      try {
        const padded = dataBase64.replaceAll("-", "+").replaceAll("_", "/")
        const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
        bytes = new Uint8Array(new ArrayBuffer(binary.length))
        for (let index = 0; index < binary.length; index += 1)
          bytes[index] = binary.charCodeAt(index)
      } catch {
        return toolError("invalid_attachment")
      }
      const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(handle.room))
      const response = await stub.fetch("https://room/surface", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Surface-MimeType": mimeType,
          "X-Room-Participant-Id": handle.participantId,
          "X-Room-Participant-Token": handle.participantToken,
        },
        body: bytes,
      })
      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >
      return response.ok
        ? toolResult(data)
        : toolError(
            typeof data.error === "string" ? data.error : "surface_unavailable"
          )
    }
  )

  server.registerTool(
    "clear_surface",
    {
      description:
        "Remove your published workspace snapshot immediately. No history is retained. Only affects your own surface.",
      inputSchema: {
        participantHandle: z.string().min(1),
      },
    },
    async ({ participantHandle }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-clear-surface",
        participantId: handle.participantId,
        token: handle.participantToken,
      })
      return result.ok
        ? toolResult(result.data)
        : toolError(controlError(result))
    }
  )

  server.registerTool(
    "read_surface",
    {
      description:
        "Read another CURRENT room participant's workspace snapshot on demand. Pass their participantId and the exact current snapshotId from room_info/wait_for_events metadata; a stale id returns surface_changed. Returns MCP ImageContent plus sanitized metadata. Observation only — reading grants no control over the source participant.",
      inputSchema: {
        participantHandle: z.string().min(1),
        sourceParticipantId: z.string().min(1),
        snapshotId: z.string().min(1).max(64),
      },
    },
    async ({ participantHandle, sourceParticipantId, snapshotId }) => {
      const handle = decodeHandle(participantHandle)
      if (!handle) return toolError("invalid_participant_handle")
      const result = await roomControl(env, handle.room, {
        action: "agent-read-surface",
        participantId: handle.participantId,
        token: handle.participantToken,
        sourceParticipantId,
        snapshotId,
      })
      if (!result.ok) return toolError(controlError(result))
      const data = result.data.data
      const surface = result.data.surface
      if (
        typeof data !== "string" ||
        !surface ||
        typeof (surface as { mimeType?: unknown }).mimeType !== "string"
      )
        return toolError("surface_not_found")
      return imageToolResult(
        { data, mimeType: (surface as { mimeType: string }).mimeType },
        { surface }
      )
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
