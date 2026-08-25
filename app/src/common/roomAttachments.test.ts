import { describe, expect, it } from "vitest"

import {
  MAX_ROOM_ATTACHMENT_BYTES,
  validateRoomAttachmentRead,
  validateUploadedRoomAttachment,
} from "./roomAttachments"

const REQUESTED_ID = "11111111-2222-4333-8444-555555555555"
// "ok" in base64 → 2 bytes.
const DATA = btoa("ok")

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    attachment: {
      id: REQUESTED_ID,
      fileName: "evidence.json",
      mimeType: "application/json",
      size: 2,
    },
    data: DATA,
    ...overrides,
  }
}

describe("validateRoomAttachmentRead (#117)", () => {
  it("accepts a payload that matches the request exactly", () => {
    const result = validateRoomAttachmentRead(validPayload(), REQUESTED_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.read.attachment.id).toBe(REQUESTED_ID)
      expect(result.read.attachment.mimeType).toBe("application/json")
      expect(result.bytes.length).toBe(2)
    }
  })

  it("rejects when returned id differs from the requested artifact", () => {
    const result = validateRoomAttachmentRead(
      validPayload({
        attachment: {
          id: "other-id",
          fileName: "x",
          mimeType: "image/png",
          size: 2,
        },
      }),
      REQUESTED_ID
    )
    expect(result.ok).toBe(false)
  })

  it("rejects unsupported MIME", () => {
    const result = validateRoomAttachmentRead(
      validPayload({
        attachment: {
          id: REQUESTED_ID,
          fileName: "x.exe",
          mimeType: "application/octet-stream",
          size: 2,
        },
      }),
      REQUESTED_ID
    )
    expect(result.ok).toBe(false)
  })

  it("rejects oversized metadata and decoded bytes beyond the bound", () => {
    expect(
      validateRoomAttachmentRead(
        validPayload({
          attachment: {
            id: REQUESTED_ID,
            fileName: "f",
            mimeType: "image/png",
            size: MAX_ROOM_ATTACHMENT_BYTES + 1,
          },
        }),
        REQUESTED_ID
      ).ok
    ).toBe(false)
    // Decoded length exceeds declared size (base64 of 3 bytes vs size=2).
    expect(
      validateRoomAttachmentRead(
        validPayload({
          attachment: {
            id: REQUESTED_ID,
            fileName: "f",
            mimeType: "text/plain",
            size: 2,
          },
          data: btoa("abc"),
        }),
        REQUESTED_ID
      ).ok
    ).toBe(false)
  })

  it("rejects invalid sizes (zero/negative/non-integer)", () => {
    for (const size of [0, -3, 1.5])
      expect(
        validateRoomAttachmentRead(
          validPayload({
            data: btoa("a"),
            attachment: {
              id: REQUESTED_ID,
              fileName: "f",
              mimeType: "text/plain",
              size,
            },
          }),
          REQUESTED_ID
        ).ok
      ).toBe(false)
  })

  it("rejects malformed base64 and empty payloads", () => {
    for (const bad of ["not!!base64", ""])
      expect(
        validateRoomAttachmentRead(validPayload({ data: bad }), REQUESTED_ID).ok
      ).toBe(false)
  })

  it("rejects non-object payloads", () => {
    expect(validateRoomAttachmentRead(undefined, REQUESTED_ID).ok).toBe(false)
    expect(validateRoomAttachmentRead("nope", REQUESTED_ID).ok).toBe(false)
  })
})

const UPLOAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function uploadedPayload(overrides: Record<string, unknown> = {}) {
  return {
    attachment: {
      id: UPLOAD_ID,
      fileName: "notes.md",
      mimeType: "text/markdown",
      size: 10,
    },
    ...overrides,
  }
}

function uploadWith(patch: Record<string, unknown>) {
  return validateUploadedRoomAttachment({
    attachment: { ...uploadedPayload().attachment, ...patch },
  })
}

describe("validateUploadedRoomAttachment (#123)", () => {
  it("accepts well-formed metadata within every bound", () => {
    const uploaded = validateUploadedRoomAttachment(uploadedPayload())
    expect(uploaded).not.toBeNull()
    expect(uploaded?.id).toBe(UPLOAD_ID)
    expect(uploaded?.fileName).toBe("notes.md")
    expect(uploaded?.mimeType).toBe("text/markdown")
    expect(uploaded?.size).toBe(10)
  })

  it("rejects malformed payloads and attachment shapes", () => {
    for (const bad of [undefined, null, "nope", {}, { attachment: "nope" }])
      expect(validateUploadedRoomAttachment(bad)).toBeNull()
  })

  it("bounds ids between 1 and 64 chars", () => {
    expect(uploadWith({ id: "" })).toBeNull()
    expect(uploadWith({ id: "a".repeat(65) })).toBeNull()
    expect(uploadWith({ id: "a".repeat(64) })).not.toBeNull()
  })

  it("bounds file names between 1 and 256 chars", () => {
    expect(uploadWith({ fileName: "" })).toBeNull()
    expect(uploadWith({ fileName: "f".repeat(257) })).toBeNull()
    expect(uploadWith({ fileName: "f".repeat(256) })).not.toBeNull()
  })

  it("enforces the shared MIME allow-list", () => {
    expect(uploadWith({ mimeType: "application/octet-stream" })).toBeNull()
    expect(uploadWith({ mimeType: "text/html" })).toBeNull()
    expect(uploadWith({ mimeType: "image/png" })).not.toBeNull()
    expect(uploadWith({ mimeType: "text/yaml" })).not.toBeNull()
  })

  it("rejects invalid sizes and accepts the exact byte ceiling", () => {
    for (const size of [
      0,
      -3,
      10.5,
      NaN,
      Infinity,
      MAX_ROOM_ATTACHMENT_BYTES + 1,
    ])
      expect(uploadWith({ size })).toBeNull()
    expect(uploadWith({ size: MAX_ROOM_ATTACHMENT_BYTES })).not.toBeNull()
    expect(uploadWith({ size: 1 })).not.toBeNull()
  })
})
