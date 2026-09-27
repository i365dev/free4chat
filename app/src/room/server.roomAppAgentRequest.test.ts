import { describe, expect, it, vi } from "vitest"

import { handleRoomRequest, isRoomRequestPath } from "./server"
import {
  ROOM_APP_MAX_PAYLOAD_BYTES,
  roomAppInstanceId,
} from "../common/roomApp"

function environment() {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true, result: { echoed: true } })
  )
  const env = {
    SFU_ROOM: {
      idFromName: vi.fn((room: string) => room),
      get: vi.fn(() => ({ fetch })),
    },
  } as never
  return { env, fetch }
}

describe("resident Room App request ingress", () => {
  it("forwards only bounded opaque JSON with participant identity in private headers", async () => {
    const { env, fetch } = environment()
    expect(isRoomRequestPath("/api/room/agent-app-request")).toBe(true)
    const appInstanceId = roomAppInstanceId("test-room", "test-app")
    const response = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/agent-app-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          appInstanceId,
          payload: { opaque: [1, "two"] },
        }),
      }),
      env
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      result: { echoed: true },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe("https://room/agent-app-request")
    expect(init?.headers).toMatchObject({
      "X-Room-Participant-Id": "agent-1",
      "X-Room-Participant-Token": "private-token",
    })
    expect(String(init.body)).toContain('"opaque"')
    expect(String(init.body)).not.toContain("private-token")
  })

  it("rejects oversized requests and untrusted origins before the Room call", async () => {
    const { env, fetch } = environment()
    const appInstanceId = roomAppInstanceId("test-room", "test-app")
    const large = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/agent-app-request", {
        method: "POST",
        headers: {
          Origin: "https://www.free4.chat",
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({
          appInstanceId,
          payload: { value: "x".repeat(ROOM_APP_MAX_PAYLOAD_BYTES) },
        }),
      }),
      env
    )
    expect(large.status).toBe(413)
    const foreign = await handleRoomRequest(
      new Request("https://www.free4.chat/api/room/agent-app-request", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": "agent-1",
          "X-Room-Participant-Token": "private-token",
        },
        body: JSON.stringify({ appInstanceId, payload: {} }),
      }),
      env
    )
    expect(foreign.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
})
