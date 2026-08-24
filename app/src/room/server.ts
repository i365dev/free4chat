import { isAllowedOrigin } from "../common/origin"
import type { RoomSession } from "../do/RoomSession"

const MAX_ROOM_LENGTH = 64
const MAX_AGENT_ATTACHMENT_BYTES = 768 * 1024
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  // Text-like attachments are also stored for agent read_attachment (#82);
  // the MCP layer returns them as text content instead of ImageContent.
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
])

export interface RoomProtocolEnv {
  SFU_ROOM: DurableObjectNamespace<RoomSession>
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export async function handleRoomRequest(
  request: Request,
  env: RoomProtocolEnv
): Promise<Response> {
  if (!isAllowedOrigin(request.headers.get("Origin")))
    return json({ error: "forbidden_origin" }, 403)
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405)

  const room = request.headers.get("X-Room-Id")?.trim() ?? ""
  const participantId = request.headers.get("X-Room-Participant-Id") ?? ""
  const token = request.headers.get("X-Room-Participant-Token") ?? ""
  if (!room || room.length > MAX_ROOM_LENGTH || !participantId || !token)
    return json({ error: "missing_room_capability" }, 400)

  const mimeType = (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]
    .toLowerCase()
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType))
    return json({ error: "unsupported_image_type" }, 415)

  const declaredSize = Number(request.headers.get("Content-Length") ?? "0")
  if (declaredSize > MAX_AGENT_ATTACHMENT_BYTES)
    return json({ error: "attachment_too_large" }, 413)
  const bytes = await request.arrayBuffer()
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_AGENT_ATTACHMENT_BYTES ||
    (declaredSize > 0 && declaredSize !== bytes.byteLength)
  )
    return json({ error: "invalid_attachment" }, 400)

  const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(room))
  const headers = new Headers()
  headers.set("Content-Type", mimeType)
  headers.set("Content-Length", String(bytes.byteLength))
  headers.set("X-Room-Participant-Id", participantId)
  headers.set("X-Room-Participant-Token", token)
  const fileName = request.headers.get("X-File-Name")
  if (fileName) headers.set("X-File-Name", fileName.slice(0, 512))
  return stub.fetch("https://room/attachment", {
    method: "POST",
    headers,
    body: bytes,
  })
}
