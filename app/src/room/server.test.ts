import { beforeEach, describe, expect, it } from "vitest"

import { handleRoomRequest, type RoomProtocolEnv } from "./server"

/**
 * Attachment upload gate for agent read_attachment (#82/#90): images were
 * the original supported class; text-like files now ride the same chunked
 * ephemeral store and come back as decoded text instead of ImageContent.
 */

const ORIGIN = "http://localhost:3000"

function makeEnv(doFetch: (request: Request) => Response): RoomProtocolEnv {
  return {
    SFU_ROOM: {
      idFromName: (name: string) => ({ name } as never),
      get: () =>
        ({
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            return Promise.resolve(doFetch(request))
          },
        } as never),
    },
  }
}

function uploadRequest(
  mimeType: string,
  body: string,
  participant?: { id: string; token: string }
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
  let doRequests: Request[]

  beforeEach(() => {
    doRequests = []
  })

  it("accepts text/markdown and forwards it to the DO with the same type", async () => {
    const env = makeEnv((request) => {
      doRequests.push(request.clone())
      return Response.json({ id: "att-1" })
    })
    const response = await handleRoomRequest(
      uploadRequest(
        "text/markdown",
        "# agenda\n\n- \u7b2c\u4e00\u9879：\u9a8c\u8bc1\u6587\u672c\u9644\u4ef6\n",
        {
          id: "human-1",
          token: "tok-1",
        }
      ),
      env
    )
    expect(response.status).toBe(200)
    expect(doRequests).toHaveLength(1)
    expect(doRequests[0].headers.get("Content-Type")).toBe("text/markdown")
  })

  it("accepts text/plain, text/csv and application/json", async () => {
    for (const mime of ["text/plain", "text/csv", "application/json"]) {
      doRequests = []
      const env = makeEnv((request) => {
        doRequests.push(request)
        return Response.json({ id: "att-2" })
      })
      const response = await handleRoomRequest(
        uploadRequest(mime, "{}", { id: "h", token: "t" }),
        env
      )
      expect(response.status).toBe(200)
      expect(doRequests[0].headers.get("Content-Type")).toBe(mime)
    }
  })

  it("still accepts image/jpeg (original class)", async () => {
    const env = makeEnv(() => Response.json({ id: "att-3" }))
    const response = await handleRoomRequest(
      uploadRequest("image/jpeg", "jpeg-bytes", { id: "h", token: "t" }),
      env
    )
    expect(response.status).toBe(200)
  })

  it("rejects unsupported binary types with 415 before touching the DO", async () => {
    const env = makeEnv(() => {
      throw new Error("DO must not be reached")
    })
    const response = await handleRoomRequest(
      uploadRequest("application/zip", "PK", { id: "h", token: "t" }),
      env
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
