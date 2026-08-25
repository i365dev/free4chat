import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client"

import type {
  AttachmentUpload,
  CollabRequestArgs,
  CollabResultArgs,
  CreateRoomResult,
  RoomSurfaceMetadataV1,
  SurfacePublishPayload,
  SurfaceReadResult,
  Free4ChatClient,
  JoinResult,
  MeetingNotesInfo,
  ParticipantRosterEntry,
  RoomEvent,
  RoomInfo,
  UploadedAttachment,
  WaitResult,
} from "../types.js"
export const FREE4CHAT_MCP_PROTOCOL_VERSION = "2026-07-28"

export type Free4ChatErrorCode =
  "invalid_participant_handle" | "room_expired" | "transient" | "tool_error"

export class Free4ChatClientError extends Error {
  constructor(
    message: string,
    readonly code: Free4ChatErrorCode
  ) {
    super(message)
    this.name = "Free4ChatClientError"
  }
}

export function decodeToolResult(result: CallToolResult): unknown {
  if (result.isError === true)
    throw new Free4ChatClientError(
      extractToolError(result) ?? "Free4Chat MCP tool failed",
      toErrorCode(extractToolError(result))
    )
  const text = result.content.find((item) => item.type === "text")
  if (!text || text.type !== "text")
    throw new Free4ChatClientError(
      "Free4Chat MCP returned no JSON result",
      "tool_error"
    )
  try {
    return JSON.parse(text.text) as unknown
  } catch {
    throw new Free4ChatClientError(
      "Free4Chat MCP returned invalid JSON",
      "tool_error"
    )
  }
}

function extractToolError(result: CallToolResult): string | undefined {
  const text = result.content.find((item) => item.type === "text")
  if (!text || text.type !== "text") return undefined
  try {
    const value = JSON.parse(text.text) as { error?: unknown }
    return typeof value.error === "string" ? value.error : undefined
  } catch {
    return undefined
  }
}

function toErrorCode(error: string | undefined): Free4ChatErrorCode {
  if (error === "invalid_participant_handle")
    return "invalid_participant_handle"
  if (error === "room_expired") return "room_expired"
  return "tool_error"
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Free4ChatClientError(
      "Free4Chat MCP returned an invalid object",
      "tool_error"
    )
  return value as Record<string, unknown>
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Free4ChatClientError(
      `Free4Chat MCP returned invalid ${field}`,
      "tool_error"
    )
  return value
}

export class McpFree4ChatClient implements Free4ChatClient {
  private readonly client = new Client(
    {
      name: "free4chat-agent-runtime",
      version: "0.1.0",
    },
    {
      versionNegotiation: {
        mode: { pin: FREE4CHAT_MCP_PROTOCOL_VERSION },
      },
    }
  )
  private transport?: StreamableHTTPClientTransport

  constructor(readonly endpoint = "https://www.free4.chat/mcp") {}

  async connect(): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(new URL(this.endpoint))
    try {
      await this.client.connect(this.transport)
      const tools = await this.client.listTools()
      const required = [
        "room_info",
        "join_room",
        "create_room",
        "wait_for_events",
        "send_text",
        "read_attachment",
        "leave_room",
        "update_capabilities",
        "send_collab_request",
        "send_collab_response",
        "send_collab_result",
        "send_attachment",
        "publish_surface",
        "clear_surface",
        "read_surface",
      ]
      if (
        required.some((name) => !tools.tools.some((tool) => tool.name === name))
      )
        throw new Error("Free4Chat MCP tool set is incomplete")
    } catch (error) {
      throw new Free4ChatClientError(
        error instanceof Error
          ? error.message
          : "Unable to connect to Free4Chat MCP",
        "transient"
      )
    }
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools()
    return result.tools.map((tool) => tool.name)
  }

  private async call(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    try {
      const result = await this.client.callTool({ name, arguments: args })
      return decodeToolResult(result)
    } catch (error) {
      if (error instanceof Free4ChatClientError) throw error
      throw new Free4ChatClientError(
        error instanceof Error
          ? error.message
          : `Free4Chat tool ${name} failed`,
        "transient"
      )
    }
  }

  async roomInfo(roomId: string): Promise<RoomInfo> {
    const result = asRecord(await this.call("room_info", { roomId }))
    const rawMeetingNotes =
      result.meetingNotes && typeof result.meetingNotes === "object"
        ? (result.meetingNotes as Record<string, unknown>)
        : {}
    const meetingNotes: MeetingNotesInfo = {
      active: rawMeetingNotes.active === true,
      ...(typeof rawMeetingNotes.agentParticipantId === "string"
        ? { agentParticipantId: rawMeetingNotes.agentParticipantId }
        : {}),
      ...(typeof rawMeetingNotes.startedAt === "number"
        ? { startedAt: rawMeetingNotes.startedAt }
        : {}),
    }
    return {
      exists: result.exists === true,
      ...(Array.isArray(result.participants)
        ? {
            participants: result.participants
              .map(normalizeRosterEntry)
              .filter(
                (entry): entry is NonNullable<typeof entry> => entry !== null
              ),
          }
        : {}),
      meetingNotes,
      // Fail closed on anything but an explicit `true` — an absent/
      // malformed field (a stale server, a parsing edge case) must never
      // be interpreted as "the media capability is available".
      meetingNotesMediaAvailable: result.meetingNotesMediaAvailable === true,
    }
  }

  async joinRoom(
    roomId: string,
    name: string,
    capabilities?: string[]
  ): Promise<JoinResult> {
    const result = asRecord(
      await this.call("join_room", {
        roomId,
        name,
        ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      })
    )
    const participant = asRecord(result.participant)
    if (
      typeof result.participantHandle !== "string" ||
      typeof participant.id !== "string"
    )
      throw new Free4ChatClientError(
        "Free4Chat returned an invalid join result",
        "tool_error"
      )
    return {
      participantId: participant.id,
      participantHandle: result.participantHandle,
      cursor: asNumber(result.cursor, "cursor"),
      expiresAt: asNumber(result.expiresAt, "expiresAt"),
    }
  }

  async createRoom(
    name: string,
    capabilities?: string[]
  ): Promise<CreateRoomResult> {
    const result = asRecord(
      await this.call("create_room", {
        name,
        ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      })
    )
    const invite =
      result.invite && typeof result.invite === "object"
        ? (result.invite as Record<string, unknown>)
        : undefined
    if (
      !invite ||
      invite.kind !== "free4chat.room-invite" ||
      invite.version !== 1 ||
      typeof invite.roomId !== "string" ||
      !invite.roomId ||
      typeof invite.roomUrl !== "string" ||
      !invite.roomUrl.startsWith("https://www.free4.chat/room?id=")
    )
      throw new Free4ChatClientError(
        "Free4Chat returned an invalid room invite",
        "tool_error"
      )
    const participant = asRecord(result.participant)
    if (
      typeof result.participantHandle !== "string" ||
      typeof participant.id !== "string"
    )
      throw new Free4ChatClientError(
        "Free4Chat returned an invalid create result",
        "tool_error"
      )
    return {
      participantId: participant.id,
      participantHandle: result.participantHandle,
      cursor: asNumber(result.cursor, "cursor"),
      expiresAt: asNumber(result.expiresAt, "expiresAt"),
      invite: {
        kind: "free4chat.room-invite",
        version: 1,
        roomId: invite.roomId,
        roomUrl: invite.roomUrl,
      },
    }
  }

  async waitForEvents(
    participantHandle: string,
    cursor: number,
    timeoutSeconds: number
  ): Promise<WaitResult> {
    const result = asRecord(
      await this.call("wait_for_events", {
        participantHandle,
        cursor,
        timeoutSeconds,
      })
    )
    return {
      events: Array.isArray(result.events)
        ? (result.events as RoomEvent[])
        : [],
      cursor: asNumber(result.cursor, "cursor"),
      expiresAt: asNumber(result.expiresAt, "expiresAt"),
      ...(Array.isArray(result.participants)
        ? {
            participants: result.participants
              .map(normalizeRosterEntry)
              .filter(
                (entry): entry is NonNullable<typeof entry> => entry !== null
              ),
          }
        : {}),
    }
  }

  async sendText(
    participantHandle: string,
    text: string
  ): Promise<{ sequence: number }> {
    const result = asRecord(
      await this.call("send_text", { participantHandle, text })
    )
    return { sequence: asNumber(result.sequence, "sequence") }
  }

  async readAttachment(
    participantHandle: string,
    attachmentId: string
  ): Promise<{ data: string; mimeType: string }> {
    let result: CallToolResult
    try {
      result = await this.client.callTool({
        name: "read_attachment",
        arguments: { participantHandle, attachmentId },
      })
    } catch (error) {
      throw new Free4ChatClientError(
        error instanceof Error ? error.message : "Unable to read attachment",
        "transient"
      )
    }
    if (result.isError === true) decodeToolResult(result)
    const image = result.content.find((item) => item.type === "image")
    if (!image || image.type !== "image")
      throw new Free4ChatClientError(
        "Free4Chat returned no image content",
        "tool_error"
      )
    return { data: image.data, mimeType: image.mimeType }
  }

  async leaveRoom(participantHandle: string): Promise<void> {
    await this.call("leave_room", { participantHandle })
  }

  async updateCapabilities(
    participantHandle: string,
    capabilities: string[]
  ): Promise<void> {
    await this.call("update_capabilities", { participantHandle, capabilities })
  }

  async sendCollabRequest(
    participantHandle: string,
    args: CollabRequestArgs
  ): Promise<{ requestId: string; sequence: number; duplicate?: boolean }> {
    const result = asRecord(
      await this.call("send_collab_request", {
        participantHandle,
        targetParticipantId: args.targetParticipantId,
        summary: args.summary,
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(args.details ? { details: args.details } : {}),
        ...(args.attachmentIds ? { attachmentIds: args.attachmentIds } : {}),
      })
    )
    return {
      requestId: String(result.requestId ?? ""),
      sequence: asNumber(result.sequence, "sequence"),
      ...(result.duplicate === true ? { duplicate: true } : {}),
    }
  }

  async sendCollabResponse(
    participantHandle: string,
    requestId: string,
    decision: "accepted" | "declined",
    summary?: string
  ): Promise<{ sequence: number }> {
    const result = asRecord(
      await this.call("send_collab_response", {
        participantHandle,
        requestId,
        decision,
        ...(summary ? { summary } : {}),
      })
    )
    return { sequence: asNumber(result.sequence, "sequence") }
  }

  async sendCollabResult(
    participantHandle: string,
    args: CollabResultArgs
  ): Promise<{ sequence: number }> {
    const result = asRecord(
      await this.call("send_collab_result", {
        participantHandle,
        requestId: args.requestId,
        status: args.status,
        summary: args.summary,
        ...(args.details ? { details: args.details } : {}),
        ...(args.attachmentIds ? { attachmentIds: args.attachmentIds } : {}),
      })
    )
    return { sequence: asNumber(result.sequence, "sequence") }
  }

  async uploadAttachment(
    participantHandle: string,
    file: AttachmentUpload
  ): Promise<UploadedAttachment> {
    const result = asRecord(
      await this.call("send_attachment", {
        participantHandle,
        fileName: file.fileName,
        mimeType: file.mimeType,
        dataBase64: file.dataBase64,
      })
    )
    const attachment = asRecord(result.attachment)
    return {
      id: String(attachment.id ?? ""),
      fileName: String(attachment.fileName ?? file.fileName),
      mimeType: String(attachment.mimeType ?? file.mimeType),
      size: asNumber(attachment.size, "size"),
      sequence: asNumber(attachment.sequence, "sequence"),
    }
  }

  async publishSurface(
    participantHandle: string,
    payload: SurfacePublishPayload
  ): Promise<{ surface: RoomSurfaceMetadataV1 }> {
    const result = asRecord(
      await this.call("publish_surface", {
        participantHandle,
        mimeType: payload.mimeType,
        dataBase64: payload.dataBase64,
      })
    )
    const surface = parseSurfaceMetadataStrict(result.surface)
    if (!surface)
      throw new Free4ChatClientError(
        "Free4Chat returned an invalid surface payload",
        "tool_error"
      )
    return { surface }
  }

  async clearSurface(participantHandle: string): Promise<void> {
    await this.call("clear_surface", { participantHandle })
  }

  async readSurface(
    participantHandle: string,
    sourceParticipantId: string,
    snapshotId: string
  ): Promise<SurfaceReadResult> {
    let result: CallToolResult
    try {
      result = await this.client.callTool({
        name: "read_surface",
        arguments: { participantHandle, sourceParticipantId, snapshotId },
      })
    } catch (error) {
      throw new Free4ChatClientError(
        error instanceof Error ? error.message : "Unable to read surface",
        "transient"
      )
    }
    if (result.isError === true) decodeToolResult(result)
    let data: string | undefined
    let mimeType: string | undefined
    for (const item of result.content) {
      if (item.type === "image") {
        data = item.data
        mimeType = item.mimeType
      }
    }
    if (!data || !mimeType)
      throw new Free4ChatClientError(
        "Free4Chat returned no image content for the surface",
        "tool_error"
      )
    let metadata: Partial<RoomSurfaceMetadataV1> = {}
    for (const item of result.content) {
      if (item.type !== "text") continue
      try {
        const parsed = JSON.parse(item.text) as {
          surface?: Record<string, unknown>
        }
        if (parsed.surface && typeof parsed.surface === "object")
          metadata = parsed.surface as Partial<RoomSurfaceMetadataV1>
      } catch {
        // Metadata envelope optional; bytes authoritative.
      }
    }
    const strict = parseSurfaceMetadataStrict({
      kind: "workspace-snapshot",
      snapshotId: metadata.snapshotId,
      mimeType: metadata.mimeType ?? mimeType,
      size: metadata.size,
      updatedAt: metadata.updatedAt,
    })
    if (!strict)
      throw new Free4ChatClientError(
        "Free4Chat returned an invalid surface payload",
        "tool_error"
      )
    // Cross-checks (#111 review): bytes must belong to the EXACT requested
    // snapshot and match the ImageContent MIME — never near-miss bytes.
    if (strict.snapshotId !== snapshotId)
      throw new Free4ChatClientError(
        "Free4Chat returned a different snapshot than requested",
        "tool_error"
      )
    if (strict.mimeType !== mimeType)
      throw new Free4ChatClientError(
        "Free4Chat returned mismatched surface content type",
        "tool_error"
      )
    return { surface: strict, data }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

// #111 review: shared STRICT surface-metadata contract. Direct publish/read
// responses must satisfy every rule (violations become typed errors);
// roster projections use the same parser but OMIT malformed entries instead.

const SURFACE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSurfaceMetadataStrict(
  raw: unknown
): RoomSurfaceMetadataV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (
    record.kind !== "workspace-snapshot" ||
    typeof record.snapshotId !== "string" ||
    !SURFACE_UUID_PATTERN.test(record.snapshotId) ||
    (record.mimeType !== "image/jpeg" &&
      record.mimeType !== "image/png" &&
      record.mimeType !== "image/webp") ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size <= 0 ||
    record.size > 768 * 1024 ||
    typeof record.updatedAt !== "number" ||
    !Number.isFinite(record.updatedAt) ||
    record.updatedAt <= 0
  )
    return null
  return {
    snapshotId: record.snapshotId,
    mimeType: record.mimeType,
    size: record.size,
    updatedAt: record.updatedAt,
  }
}

/** Validates one raw roster participant and projects it to the sanitized
 * Runtime shape. Returns null for entries without a usable id; malformed
 * surface metadata is omitted rather than rejected (roster tolerance). */
export function normalizeRosterEntry(
  raw: unknown
): ParticipantRosterEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id : ""
  if (!id) return null
  const capabilities =
    record.capabilities && typeof record.capabilities === "object"
      ? (record.capabilities as Record<string, unknown>)
      : undefined
  // Two server projections exist (#111 review): room_info nests tokens under
  // capabilities.advertised; the compact wait-roster flattens them to a
  // top-level advertised array. Accept both.
  const source =
    record.advertised !== undefined
      ? record.advertised
      : Array.isArray(capabilities?.advertised)
        ? capabilities.advertised
        : undefined
  const advertised = Array.isArray(source)
    ? source.filter((token): token is string => typeof token === "string")
    : undefined
  return {
    id,
    name: typeof record.name === "string" ? record.name : "",
    kind: record.kind === "agent" ? "agent" : "human",
    ...(advertised && advertised.length > 0 ? { advertised } : {}),
    ...(() => {
      const surface = parseSurfaceMetadataStrict(record.surface)
      return surface ? { surface } : {}
    })(),
  }
}
