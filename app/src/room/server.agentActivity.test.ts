import { describe, expect, it } from "vitest"

import {
  handleRoomRequest,
  isRoomRequestPath,
  type RoomProtocolEnv,
} from "./server"

describe("Runtime Agent activity route", () => {
  it("keeps the route on the Worker protocol allowlist and forwards only its bounded body", async () => {
    let forwarded: { body: Record<string, unknown>; url: string } | undefined
    const env = {
      SFU_ROOM: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          fetch: async (url: string | URL, init?: RequestInit) => {
            forwarded = {
              url: String(url),
              body: JSON.parse(String(init?.body ?? "{}")) as Record<
                string,
                unknown
              >,
            }
            return Response.json({ ok: true })
          },
        }),
      },
    } as unknown as RoomProtocolEnv

    expect(isRoomRequestPath("/api/room/agent-activity")).toBe(true)
    const response = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/agent-activity", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "X-Room-Id": "room-1",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          scopeId: "task:req-1",
          activity: "thinking",
          turnSequence: 42,
        }),
      }),
      env
    )
    expect(response.status).toBe(200)
    expect(forwarded).toEqual({
      url: "https://room/control",
      body: {
        action: "agent-activity",
        participantId: "agent-1",
        token: "private-token",
        scopeId: "task:req-1",
        activity: "thinking",
        turnSequence: 42,
      },
    })
  })

  it("forwards a legacy Agent body with no turnSequence untouched", async () => {
    let forwardedBody: Record<string, unknown> | undefined
    const env = {
      SFU_ROOM: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          fetch: async (_url: string | URL, init?: RequestInit) => {
            forwardedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
              string,
              unknown
            >
            return Response.json({ ok: true })
          },
        }),
      },
    } as unknown as RoomProtocolEnv

    // A pre-#414 Agent Runtime sends only scopeId + activity. The route must
    // not invent a turn: an absent field stays absent, so the Durable Object
    // takes its legacy-compatible path.
    const response = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/agent-activity", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "X-Room-Id": "room-1",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({ scopeId: "task:req-1", activity: "thinking" }),
      }),
      env
    )

    expect(response.status).toBe(200)
    expect(forwardedBody).toEqual({
      action: "agent-activity",
      participantId: "agent-1",
      token: "private-token",
      scopeId: "task:req-1",
      activity: "thinking",
    })
    expect("turnSequence" in (forwardedBody ?? {})).toBe(false)
  })

  it("rejects the wrong method before touching the Durable Object", async () => {
    const env = {
      SFU_ROOM: {
        idFromName: () => ({}),
        get: () => ({
          fetch: () => Promise.reject(new Error("must not call DO")),
        }),
      },
    } as unknown as RoomProtocolEnv
    const response = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/agent-activity", {
        method: "GET",
        headers: { Origin: "http://localhost:3000" },
      }),
      env
    )
    expect(response.status).toBe(405)
  })
})
