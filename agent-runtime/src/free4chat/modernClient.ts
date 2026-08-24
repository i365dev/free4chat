import { Free4ChatClientError } from "./client.js"
import type { Free4ChatErrorCode } from "./client.js"
import type { Free4ChatClient } from "../types.js"
import type { JoinResult, RoomInfo, WaitResult } from "../types.js"

/**
 * Modern-era MCP transport for the Free4Chat room endpoint.
 *
 * The deployed /mcp serves the 2026-07-28 protocol revision only: every
 * tools/call must carry a per-request `_meta` envelope (protocol version +
 * client capabilities) plus matching `Mcp-Method`/`Mcp-Name` headers, and
 * the legacy initialize handshake is rejected outright. The SDK client
 * used by McpFree4ChatClient predates that revision, so this class speaks
 * the wire format directly over fetch while implementing the same
 * Free4ChatClient interface and result validation.
 */

const MODERN_PROTOCOL_VERSION = "2026-07-28"
const REQUIRED_TOOLS = [
  "room_info",
  "join_room",
  "wait_for_events",
  "send_text",
  "read_attachment",
  "leave_room",
] as const

function envelopeMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (
    process.env.FREE4CHAT_MCP_DEBUG === "1" &&
    !(value !== null && typeof value === "object" && !Array.isArray(value))
  )
    console.error(
      "[mcp-debug] non-object payload:",
      JSON.stringify(value)?.slice(0, 300),
      new Error("trace").stack
    )
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>
  throw new Free4ChatClientError(
    "Free4Chat returned an unexpected payload shape",
    "tool_error"
  )
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Free4ChatClientError(
    `Free4Chat response is missing ${field}`,
    "tool_error"
  )
}

// Mirrors the legacy client's toErrorCode(): the runtime rejoin/room-expiry
// lifecycle switches on these codes, so they must survive the modern
// transport unchanged.
function toToolErrorCode(error: string | undefined): Free4ChatErrorCode {
  if (error === "invalid_participant_handle")
    return "invalid_participant_handle"
  if (error === "room_expired") return "room_expired"
  return "tool_error"
}

function decodeTextPayload(raw: unknown): unknown {
  const result = asRecord(raw)
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : []
    const first = asRecord(content[0] ?? {})
    let errorString: string | undefined
    if (typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text) as { error?: unknown }
        if (typeof parsed.error === "string") errorString = parsed.error
      } catch {
        errorString = undefined
      }
      if (errorString === undefined) errorString = first.text
      throw new Free4ChatClientError(errorString, toToolErrorCode(errorString))
    }
    throw new Free4ChatClientError(
      "Free4Chat tool error",
      toToolErrorCode(undefined)
    )
  }
  const content = Array.isArray(result.content) ? result.content : []
  for (const item of content) {
    const block = asRecord(item)
    if (block.type === "text" && typeof block.text === "string")
      return JSON.parse(block.text)
  }
  throw new Free4ChatClientError(
    "Free4Chat tool returned no text content",
    "tool_error"
  )
}

export class ModernMcpFree4ChatClient implements Free4ChatClient {
  private rpcId = 0
  private connected = false

  constructor(readonly endpoint = "https://www.free4.chat/mcp") {}

  /** Verifies the endpoint answers a modern tools/call with the expected
   * tool set. No session state is kept — every call is self-contained. */
  async connect(): Promise<void> {
    const names = await this.listTools()
    const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name))
    if (missing.length > 0)
      throw new Free4ChatClientError(
        `Free4Chat MCP tool set is incomplete (missing ${missing.join(", ")})`,
        "tool_error"
      )
    this.connected = true
  }

  async listTools(): Promise<string[]> {
    const body = this.envelope("tools/list", {})
    const raw = await this.post(body, { "Mcp-Method": "tools/list" })
    const result = asRecord(raw)
    const tools = Array.isArray(result.tools) ? result.tools : []
    return tools.map((t) => String(asRecord(t).name))
  }

  private envelope(
    method: "tools/call" | "tools/list",
    params: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method,
      params: { ...params, _meta: envelopeMeta() },
    }
  }

  private async post(
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw new Free4ChatClientError(
        error instanceof Error ? error.message : "network failure",
        "transient"
      )
    }
    const text = await response.text()
    if (!response.ok) {
      // Lifecycle errors can surface at the HTTP layer; classify them so the
      // runtime rejoin/expiry logic keeps working like the legacy client.
      const knownLifecycle = [
        "invalid_participant_handle",
        "room_expired",
      ] as const
      for (const known of knownLifecycle) {
        if (text.includes(known)) throw new Free4ChatClientError(known, known)
      }
      throw new Free4ChatClientError(
        `Free4Chat MCP HTTP ${response.status}: ${text.slice(0, 200)}`,
        response.status >= 500 || response.status === 429
          ? "transient"
          : "tool_error"
      )
    }
    const contentType = response.headers.get("content-type") ?? ""
    let payload: Record<string, unknown>
    if (contentType.includes("text/event-stream")) {
      let last: string | undefined
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) last = line.slice(5).trim()
      }
      if (last === undefined)
        throw new Free4ChatClientError(
          "Free4Chat MCP SSE response carried no data frame",
          "transient"
        )
      payload = JSON.parse(last)
    } else {
      payload = JSON.parse(text)
    }
    if (payload.error !== undefined && payload.error !== null) {
      const err = asRecord(payload.error)
      throw new Free4ChatClientError(
        `Free4Chat MCP RPC ${String(err.code)}: ${String(err.message)}`,
        "transient"
      )
    }
    return payload.result
  }

  private async rawCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const body = this.envelope("tools/call", {
      name: toolName,
      arguments: args,
    })
    return decodeTextPayload(
      await this.post(body, {
        "Mcp-Method": "tools/call",
        "Mcp-Name": toolName,
      })
    )
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    try {
      return await this.rawCall(toolName, args)
    } catch (error) {
      if (error instanceof Free4ChatClientError) throw error
      throw new Free4ChatClientError(
        error instanceof Error
          ? error.message
          : `Free4Chat tool ${toolName} failed`,
        "transient"
      )
    }
  }

  async roomInfo(roomId: string): Promise<RoomInfo> {
    const result = asRecord(await this.callTool("room_info", { roomId }))
    const rawMeetingNotes =
      result.meetingNotes && typeof result.meetingNotes === "object"
        ? (result.meetingNotes as Record<string, unknown>)
        : {}
    return {
      exists: result.exists === true,
      meetingNotes: {
        active: rawMeetingNotes.active === true,
        ...(typeof rawMeetingNotes.agentParticipantId === "string"
          ? { agentParticipantId: rawMeetingNotes.agentParticipantId }
          : {}),
        ...(typeof rawMeetingNotes.startedAt === "number"
          ? { startedAt: rawMeetingNotes.startedAt }
          : {}),
      },
      // Fail closed on anything but an explicit `true`.
      meetingNotesMediaAvailable: result.meetingNotesMediaAvailable === true,
    }
  }

  async joinRoom(roomId: string, name: string): Promise<JoinResult> {
    const result = asRecord(await this.callTool("join_room", { roomId, name }))
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
      await this.callTool("wait_for_events", {
        participantHandle,
        cursor,
        timeoutSeconds,
      })
    )
    return {
      events: Array.isArray(result.events) ? (result.events as never[]) : [],
      cursor: asNumber(result.cursor, "cursor"),
      expiresAt: asNumber(result.expiresAt, "expiresAt"),
    }
  }

  async sendText(
    participantHandle: string,
    text: string
  ): Promise<{ sequence: number }> {
    const result = asRecord(
      await this.callTool("send_text", { participantHandle, text })
    )
    return { sequence: asNumber(result.sequence, "sequence") }
  }

  async readAttachment(
    participantHandle: string,
    attachmentId: string
  ): Promise<{ data: string; mimeType: string; text?: string }> {
    const body = this.envelope("tools/call", {
      name: "read_attachment",
      arguments: { participantHandle, attachmentId },
    })
    let rawResult: unknown
    try {
      rawResult = await this.post(body, {
        "Mcp-Method": "tools/call",
        "Mcp-Name": "read_attachment",
      })
    } catch (error) {
      throw new Free4ChatClientError(
        error instanceof Error ? error.message : "Unable to read attachment",
        "transient"
      )
    }
    const result = asRecord(rawResult)
    if (result.isError === true) decodeTextPayload(rawResult)
    const content = Array.isArray(result.content) ? result.content : []
    for (const item of content) {
      const block = asRecord(item)
      if (block.type === "image")
        return {
          data: String(block.data ?? ""),
          mimeType: String(block.mimeType ?? ""),
        }
    }
    // Text-like attachments ride in the standard JSON envelope:
    // { attachment, data, text }.
    for (const item of content) {
      const block = asRecord(item)
      if (block.type !== "text") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(String(block.text ?? ""))
      } catch {
        continue
      }
      const payload = asRecord(parsed)
      const attachment = asRecord(payload.attachment ?? {})
      const mimeType = String(attachment.mimeType ?? "")
      if (typeof payload.text === "string")
        return {
          data: String(payload.data ?? ""),
          mimeType,
          text: payload.text,
        }
    }
    throw new Free4ChatClientError(
      "Free4Chat returned no image content",
      "tool_error"
    )
  }

  async leaveRoom(participantHandle: string): Promise<void> {
    await this.callTool("leave_room", { participantHandle })
  }

  async close(): Promise<void> {
    this.connected = false
  }
}
