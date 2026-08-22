import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client"

import type {
  Free4ChatClient,
  JoinResult,
  MeetingNotesInfo,
  RoomEvent,
  RoomInfo,
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
        "wait_for_events",
        "send_text",
        "read_attachment",
        "leave_room",
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
      meetingNotes,
      // Fail closed on anything but an explicit `true` — an absent/
      // malformed field (a stale server, a parsing edge case) must never
      // be interpreted as "the media capability is available".
      meetingNotesMediaAvailable: result.meetingNotesMediaAvailable === true,
    }
  }

  async joinRoom(roomId: string, name: string): Promise<JoinResult> {
    const result = asRecord(await this.call("join_room", { roomId, name }))
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

  async close(): Promise<void> {
    await this.client.close()
  }
}
