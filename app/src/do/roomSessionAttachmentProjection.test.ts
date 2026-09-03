import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #234: standalone Room attachments are projected into browser RoomState as
// bounded metadata with a server-resolved sender kind, and a live
// "attachment" event reaches connected browsers on upload. Bytes never enter
// state — only the authenticated read path returns them.

function buildStoredRoom() {
  return {
    createdAt: Date.now(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": {
        id: "human-1",
        name: "Human",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-human",
        media: {},
      },
      "agent-pi": {
        id: "agent-pi",
        name: "Pi",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "tok-pi",
        capabilities: { text: true },
      },
    },
    messages: [],
    nextMessageSequence: 1,
    meetingNotes: { active: false },
    agentVoice: {},
    liveTranscript: { active: false },
    pendingMediaCleanup: [],
  }
}

function makeRoom() {
  const store = new Map<string, unknown>([["room", buildStoredRoom()]])
  const broadcasts: Array<Record<string, unknown>> = []
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async () => new Map<string, unknown>(),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => {
      const socket = {
        send: (raw: string) =>
          broadcasts.push(JSON.parse(raw) as Record<string, unknown>),
        close: () => undefined,
      } as unknown as WebSocket
      return [socket]
    },
    waitUntil: (promise: Promise<unknown>) => void promise,
    id: { name: "test-room", toString: () => "test-room" },
  }
  const rs = new RoomSession(
    ctx as never,
    { SFU_ROOM: {}, AGENT_MEDIA_ENABLED: "true" } as never
  )
  const upload = (sender: { id: string; token: string }, body: string) =>
    rs.fetch(
      new Request("https://room/attachment", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Room-Id": "test-room",
          "X-Room-Participant-Id": sender.id,
          "X-Room-Participant-Token": sender.token,
          "X-File-Name": "fib.py",
        },
        body,
      })
    )
  const resync = async () => {
    const socket = {
      send: vi.fn(),
      close: () => undefined,
    }
    await (
      rs as unknown as {
        handleClientMessage: (
          socket: { send: ReturnType<typeof vi.fn>; close: () => void },
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      socket,
      { participantId: "human-1", token: "tok-human", connectionNonce: "n" },
      { type: "resync" }
    )
    return JSON.parse(socket.send.mock.calls[0][0] as string) as {
      type: string
      state: { attachments?: Array<Record<string, unknown>> }
    }
  }
  return { rs, upload, resync, broadcasts, store }
}

describe("standalone attachment state projection (#234)", () => {
  it("Agent uploads appear in browser RoomState with senderKind=agent", async () => {
    const { upload, resync, broadcasts } = makeRoom()
    const response = await upload(
      { id: "agent-pi", token: "tok-pi" },
      "print('fib')"
    )
    expect(response.status).toBe(200)
    const meta = (await response.json()) as { attachment: { id?: string } }

    const state = await resync()
    expect(state.type).toBe("state")
    const attachments = state.state.attachments ?? []
    expect(attachments).toHaveLength(1)
    expect(attachments[0].id).toBe(meta.attachment.id)
    expect(attachments[0].senderName).toBe("Pi")
    expect(attachments[0].senderKind).toBe("agent")
    expect(attachments[0].fileName).toBe("fib.py")
    expect(attachments[0].sequence).toBeGreaterThan(0)
    // No bytes ever enter state.
    expect(JSON.stringify(attachments)).not.toContain("print('fib')")

    // A live attachment event reaches connected browsers too.
    const event = broadcasts.find((b) => b.type === "attachment") as {
      attachment?: Record<string, unknown>
    }
    expect(event?.attachment?.id).toBe(meta.attachment.id)
    expect(event?.attachment?.senderKind).toBe("agent")
  })

  it("Human Agent-consumption copies project as senderKind=human (browser never renders them standalone)", async () => {
    const { upload, resync } = makeRoom()
    const response = await upload(
      { id: "human-1", token: "tok-human" },
      "human file copy"
    )
    expect(response.status).toBe(200)
    const state = await resync()
    const attachments = state.state.attachments ?? []
    expect(attachments).toHaveLength(1)
    expect(attachments[0].senderKind).toBe("human")
  })

  it("Agent attachment survives the sender leaving: still visible with senderKind=agent and readable (#234)", async () => {
    const { rs, upload, resync, store } = makeRoom()
    const response = await upload(
      { id: "agent-pi", token: "tok-pi" },
      "print('fib')"
    )
    expect(response.status).toBe(200)
    const meta = (await response.json()) as { attachment: { id?: string } }

    // The agent leaves; the participant record is deleted.
    const left = await rs.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "agent-leave",
          participantId: "agent-pi",
          token: "tok-pi",
        }),
      })
    )
    expect(left.status).toBe(200)
    const room = store.get("room") as { participants: Record<string, unknown> }
    expect(room.participants["agent-pi"]).toBeUndefined()

    // A Human resync still projects the attachment — persisted senderKind,
    // not the live roster.
    const state = await resync()
    const attachments = state.state.attachments ?? []
    expect(attachments).toHaveLength(1)
    expect(attachments[0].id).toBe(meta.attachment.id)
    expect(attachments[0].senderKind).toBe("agent")

    // Preview/read still works through the authenticated read path.
    const read = await rs.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "human-read-attachment",
          participantId: "human-1",
          token: "tok-human",
          attachmentId: meta.attachment.id,
        }),
      })
    )
    expect(read.status).toBe(200)
    const readBody = (await read.json()) as { data?: string }
    expect(readBody.data).toBe(btoa("print('fib')"))
  })
})
