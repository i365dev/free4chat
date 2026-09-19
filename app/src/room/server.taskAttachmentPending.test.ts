import { describe, expect, it } from "vitest"

import { handleRoomRequest, type RoomProtocolEnv } from "./server"
import {
  TASK_ATTACHMENT_PENDING_HEADER,
  TASK_ATTACHMENT_WAKE_HEADER,
} from "../common/taskAttachmentWake"

/**
 * #421 — the Worker is a HEADER ALLOW-LIST, not a transparent proxy.
 *
 * Production dogfood caught this the hard way: the Start Task large-brief path
 * uploaded the brief with the pre-Task marker, the Worker silently dropped the
 * unknown header, and the Room correctly refused an unknown Task. The Human saw
 * "could not attach the brief"; the browser saw a 409 with no explanation.
 *
 * These tests pin the transport contract: the marker is forwarded as exactly
 * one canonical token, and an absent or unrecognized value is NOT forwarded —
 * so the Room's fail-closed rule for an unknown Task is unchanged.
 */

type CapturedUpload = {
  taskRequestId: string | null
  pending: string | null
  taskWake: string | null
}

function envCapturing(uploads: CapturedUpload[]): RoomProtocolEnv {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: (
        _url: string | URL,
        init?: { headers?: { get: (name: string) => string | null } }
      ) => {
        const header = (name: string) =>
          init?.headers?.get(name) ??
          init?.headers?.get(name.toLowerCase()) ??
          null
        uploads.push({
          taskRequestId: header("X-Task-Request-Id"),
          pending: header(TASK_ATTACHMENT_PENDING_HEADER),
          taskWake: header(TASK_ATTACHMENT_WAKE_HEADER),
        })
        return Promise.resolve(Response.json({ attachment: { id: "att-1" } }))
      },
    }),
  }
  return { SFU_ROOM: namespace as unknown as RoomProtocolEnv["SFU_ROOM"] }
}

function upload(
  env: RoomProtocolEnv,
  headers: Record<string, string>
): Promise<Response> {
  const body = "brief bytes"
  return handleRoomRequest(
    new Request("https://www.free4.chat/api/room/attachments", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "text/markdown",
        "Content-Length": String(body.length),
        "X-Room-Id": "test-room",
        "X-Room-Participant-Id": "human-1",
        "X-Room-Participant-Token": "tok-human",
        "X-File-Name": "task-brief.md",
        ...headers,
      },
      body,
    }),
    env
  )
}

const PRE_TASK_ID = "6f1c2f9c-0b3a-4a1f-9d5a-2b8f7c0e4d21"

describe("Worker pre-Task attachment transport (#421)", () => {
  it("forwards the canonical pre-Task marker and the pinned Task id", async () => {
    const uploads: CapturedUpload[] = []
    const response = await upload(envCapturing(uploads), {
      "X-Task-Request-Id": PRE_TASK_ID,
      [TASK_ATTACHMENT_PENDING_HEADER]: "1",
    })
    expect(response.status).toBe(200)
    expect(uploads).toEqual([
      {
        taskRequestId: PRE_TASK_ID,
        pending: "1",
        taskWake: null,
      },
    ])
  })

  it("never forwards an unrecognized marker value", async () => {
    // (`Headers` normalizes surrounding whitespace per the HTTP spec, so
    // " 1" is literally the canonical token by the time it is read.)
    for (const value of ["", "0", "true", "yes", "01", "TRUE"]) {
      const uploads: CapturedUpload[] = []
      await upload(envCapturing(uploads), {
        "X-Task-Request-Id": PRE_TASK_ID,
        [TASK_ATTACHMENT_PENDING_HEADER]: value,
      })
      expect(uploads[0].pending).toBeNull()
    }
  })

  it("keeps the wake token and the pre-Task marker independent", async () => {
    const uploads: CapturedUpload[] = []
    await upload(envCapturing(uploads), {
      "X-Task-Request-Id": PRE_TASK_ID,
      [TASK_ATTACHMENT_PENDING_HEADER]: "1",
      [TASK_ATTACHMENT_WAKE_HEADER]: "1",
    })
    // Both cross as their own canonical token: the Room, not the Worker,
    // decides that a pre-Task upload can never be a wake.
    expect(uploads[0]).toMatchObject({ pending: "1", taskWake: "1" })
  })

  it("bounds the pinned Task id exactly like the canonical request id", async () => {
    const uploads: CapturedUpload[] = []
    await upload(envCapturing(uploads), {
      "X-Task-Request-Id": "x".repeat(200),
      [TASK_ATTACHMENT_PENDING_HEADER]: "1",
    })
    expect(uploads[0].taskRequestId).toHaveLength(64)
  })
})
