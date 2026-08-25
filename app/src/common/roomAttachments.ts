import {
  ROOM_ATTACHMENT_MIME_TYPES,
  type RoomAttachmentRead,
} from "../room/types"

// #117: strict browser-boundary validation for Human artifact reads. The
// Worker/DO response is UNTRUSTED at this boundary: every field is checked,
// decoded bytes must match the metadata exactly, and any violation fails
// closed BEFORE an object URL or preview can exist.

export const MAX_ROOM_ATTACHMENT_BYTES = 768 * 1024

function decodeBase64(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index)
    return bytes.length === 0 ? null : bytes
  } catch {
    return null
  }
}

/** Validates and normalizes one artifact-read payload. Returns typed error
 * strings (boring, stable) instead of throwing so callers render a small
 * actionable message. On success the decoded bytes ride along once. */
export function validateRoomAttachmentRead(
  payload: unknown,
  requestedAttachmentId: string
):
  | { ok: true; read: RoomAttachmentRead; bytes: Uint8Array }
  | { ok: false; error: string } {
  if (!payload || typeof payload !== "object")
    return { ok: false, error: "invalid_attachment_payload" }
  const record = payload as Record<string, unknown>
  const attachment =
    record.attachment && typeof record.attachment === "object"
      ? (record.attachment as Record<string, unknown>)
      : undefined
  if (
    !attachment ||
    typeof attachment.id !== "string" ||
    typeof attachment.fileName !== "string" ||
    attachment.fileName.length === 0 ||
    attachment.fileName.length > 256 ||
    !ROOM_ATTACHMENT_MIME_TYPES.includes(attachment.mimeType as never) ||
    typeof record.data !== "string"
  )
    return { ok: false, error: "invalid_attachment_payload" }

  // The response must be for EXACTLY the requested artifact — never a
  // near-miss or a different participant's file.
  if (attachment.id !== requestedAttachmentId)
    return { ok: false, error: "attachment_mismatch" }

  if (
    typeof attachment.size !== "number" ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size <= 0 ||
    attachment.size > MAX_ROOM_ATTACHMENT_BYTES
  )
    return { ok: false, error: "invalid_attachment_payload" }

  const bytes = decodeBase64(record.data)
  if (!bytes || bytes.length !== attachment.size)
    return { ok: false, error: "invalid_attachment_payload" }

  return {
    ok: true,
    read: {
      attachment: {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType:
          attachment.mimeType as RoomAttachmentRead["attachment"]["mimeType"],
        size: attachment.size,
      },
      data: record.data,
    },
    bytes,
  }
}
