import { beforeEach, describe, expect, it } from "vitest"

import { handleRoomRequest, type RoomProtocolEnv } from "./server"

/**
 * Attachment upload gate for agent read_attachment (#82/#90): images were
 * the original supported class; text-like files now ride the same chunked
 * ephemeral store and come back as decoded text instead of ImageContent.
 */

const ORIGIN = "http://localhost:3000"

type CapturedUpload = { contentType: string | null }
type CapturedControl = {
  body: Record<string, unknown>
  contentType: string | null
}

function makeEnv(
  doFetch: (upload: { contentType: string | null }) => Response
): RoomProtocolEnv {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    // handleRoomRequest calls stub.fetch(url, init); capture the forwarded
    // Content-Type from the init headers.
    get: () => ({
      fetch: (
        _url: string | URL,
        init?: { headers?: { get: (name: string) => string | null } }
      ) =>
        Promise.resolve(
          doFetch({
            contentType:
              init?.headers?.get("Content-Type") ??
              init?.headers?.get("content-type") ??
              null,
          })
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

function liveTranscriptEnv(captured: CapturedControl[]): RoomProtocolEnv {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (
        _url: string | URL,
        init?: { body?: BodyInit | null; headers?: HeadersInit }
      ) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >
        const headers = new Headers(init?.headers)
        captured.push({
          body,
          contentType: headers.get("Content-Type"),
        })
        return Response.json({ ok: true })
      },
    }),
  }
  return { SFU_ROOM: namespace as unknown as RoomProtocolEnv["SFU_ROOM"] }
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
      env
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
        env
      )
      expect(response.status).toBe(200)
      expect(uploads[0]?.contentType).toBe(mime)
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

describe("Live Transcript Runtime append gate", () => {
  it("forwards only the narrow authenticated segment control payload", async () => {
    const captured: CapturedControl[] = []
    const request = new Request(
      "https://www.free4.chat/api/room/live-transcript/append",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          epoch: 7,
          segmentId: "lt_abc",
          sourceParticipantId: "human-1",
          text: "Decision recorded.",
          speaker: "must-not-cross-this-boundary",
          rawAudio: "must-not-cross-this-boundary",
        }),
      }
    )
    const response = await handleRoomRequest(
      request,
      liveTranscriptEnv(captured)
    )
    expect(response.status).toBe(200)
    expect(captured).toEqual([
      {
        contentType: "application/json",
        body: {
          action: "agent-live-transcript-append",
          participantId: "agent-1",
          token: "private-token",
          epoch: 7,
          segmentId: "lt_abc",
          sourceParticipantId: "human-1",
          text: "Decision recorded.",
        },
      },
    ])
  })

  it("rejects a malformed Runtime append before contacting the Room", async () => {
    const request = new Request(
      "https://www.free4.chat/api/room/live-transcript/append",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          epoch: 0,
          segmentId: "x",
          sourceParticipantId: "h",
          text: "x",
        }),
      }
    )
    const env = liveTranscriptEnv([])
    const response = await handleRoomRequest(request, env)
    expect(response.status).toBe(400)
  })
})

describe("Runtime provider connection gate", () => {
  it("forwards only an authenticated Runtime connection control payload", async () => {
    const captured: CapturedControl[] = []
    const request = new Request(
      "https://www.free4.chat/api/room/runtime-provider/connect",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          runtimeHost: {
            runtimeHostId: "host-176-provider",
            speech: { stt: true, tts: false },
          },
          providerClaimHash: "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w",
          runtimeProviderHandle: "must-not-cross-this-boundary",
        }),
      }
    )
    const response = await handleRoomRequest(
      request,
      liveTranscriptEnv(captured)
    )
    expect(response.status).toBe(200)
    expect(captured).toEqual([
      {
        contentType: "application/json",
        body: {
          action: "agent-connect-runtime-provider",
          participantId: "agent-1",
          token: "private-token",
          runtimeHost: {
            runtimeHostId: "host-176-provider",
            speech: { stt: true, tts: false },
          },
          providerClaimHash: "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w",
        },
      },
    ])
  })

  it("rejects a malformed provider connection before contacting the Room", async () => {
    const request = new Request(
      "https://www.free4.chat/api/room/runtime-provider/connect",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          runtimeHost: { runtimeHostId: "copied", speech: { stt: true } },
          providerClaimHash: "not-a-claim",
        }),
      }
    )
    const env = liveTranscriptEnv([])
    const response = await handleRoomRequest(request, env)
    expect(response.status).toBe(400)
  })
})
