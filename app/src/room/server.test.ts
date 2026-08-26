import { beforeEach, describe, expect, it } from "vitest"

import { handleRoomRequest, type RoomProtocolEnv } from "./server"

/**
 * Attachment upload gate for agent read_attachment (#82/#90): images were
 * the original supported class; text-like files now ride the same chunked
 * ephemeral store and come back as decoded text instead of ImageContent.
 */

const ORIGIN = "http://localhost:3000"

type CapturedUpload = { contentType: string | null }

function makeEnv(
  doFetch: (upload: { contentType: string | null }) => Response,
): RoomProtocolEnv {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    // handleRoomRequest calls stub.fetch(url, init); capture the forwarded
    // Content-Type from the init headers.
    get: () => ({
      fetch: (
        _url: string | URL,
        init?: { headers?: { get: (name: string) => string | null } },
      ) =>
        Promise.resolve(
          doFetch({
            contentType:
              init?.headers?.get("Content-Type") ??
              init?.headers?.get("content-type") ??
              null,
          }),
        ),
    }),
  }
  return {
    SFU_ROOM: namespace as unknown as RoomProtocolEnv["SFU_ROOM"],
  }
}

function envCapturing(uploads: CapturedUpload[]): RoomProtocolEnv {
  return makeEnv((upload) => {
    uploads.push(upload)
    return Response.json({ id: "att-x" })
  })
}

function uploadRequest(
  mimeType: string,
  body: string,
  participant?: { id: string; token: string },
): Request {
  return new Request("https://www.free4.chat/api/room/attachments", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": mimeType,
      "X-Room-Id": "test-room",
      ...(participant
        ? {
            "X-Room-Participant-Id": participant.id,
            "X-Room-Participant-Token": participant.token,
          }
        : {}),
      "X-File-Name": encodeURIComponent("notes.md"),
    },
    body,
  })
}

describe("room attachment upload gate", () => {
  let uploads: CapturedUpload[]

  beforeEach(() => {
    uploads = []
  })

  it("accepts text/markdown and forwards it to the DO with the same type", async () => {
    const env = envCapturing(uploads)
    const response = await handleRoomRequest(
      uploadRequest("text/markdown", "# agenda\n\n- item one\n", {
        id: "human-1",
        token: "tok-1",
      }),
      env,
    )
    expect(response.status).toBe(200)
    expect(uploads).toEqual([{ contentType: "text/markdown" }])
  })

  it("accepts text/plain, text/csv and application/json", async () => {
    for (const mime of ["text/plain", "text/csv", "application/json"]) {
      uploads = []
      const env = envCapturing(uploads)
      const response = await handleRoomRequest(
        uploadRequest(mime, "{}", { id: "h", token: "t" }),
        env,
      )
      expect(response.status).toBe(200)
      expect(uploads[0]?.contentType).toBe(mime)
    }
  })

  it("still accepts image/jpeg (original class)", async () => {
    const env = makeEnv(() => Response.json({ id: "att-3" }))
    const response = await handleRoomRequest(
      uploadRequest("image/jpeg", "jpeg-bytes", { id: "h", token: "t" }),
      env,
    )
    expect(response.status).toBe(200)
  })

  it("rejects unsupported binary types with 415 before touching the DO", async () => {
    const env = makeEnv(() => {
      throw new Error("DO must not be reached")
    })
    const response = await handleRoomRequest(
      uploadRequest("application/zip", "PK", { id: "h", token: "t" }),
      env,
    )
    expect(response.status).toBe(415)
  })

  it("rejects when origin is missing", async () => {
    const request = new Request("https://www.free4.chat/api/room/attachments", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: "x",
    })
    const env = makeEnv(() => Response.json({}))
    const response = await handleRoomRequest(request, env)
    expect(response.status).toBe(403)
  })
})
