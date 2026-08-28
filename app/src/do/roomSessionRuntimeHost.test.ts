import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #176 Phase A fixture: one Human plus Agents so the Runtime Host projection
// can be exercised against the real DO register/update/projection paths.
function buildStoredRoom(
  agentRuntimeHosts: Record<string, unknown | undefined> = {}
) {
  const agentIds = ["agent-a", "agent-b"]
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
        token: "tok-h1",
      },
      ...Object.fromEntries(
        agentIds.map((id) => [
          id,
          {
            id,
            name: `Agent-${id}`,
            kind: "agent",
            connected: true,
            joinedAt: 1,
            lastSeenAt: Date.now(),
            token: `tok-${id}`,
            ...(agentRuntimeHosts[id] !== undefined
              ? { runtimeHost: agentRuntimeHosts[id] }
              : {}),
          },
        ])
      ),
    },
    messages: [],
    nextMessageSequence: 1,
    meetingNotes: { active: false },
    voiceReply: { active: false },
    pendingMediaCleanup: [],
  }
}

const VALID_HOST = {
  runtimeHostId: "11111111-2222-3333-4444-555555555555",
  speech: { stt: true, tts: false },
}

function makeRoomSession(stored: ReturnType<typeof buildStoredRoom>) {
  const store = new Map<string, unknown>([["room", stored]])
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [] as WebSocket[],
  }
  const rs = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  const control = async (body: Record<string, unknown>) => {
    const response = await rs.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    }
  }
  const agentRegister = (runtimeHost?: unknown, id = "agent-new") =>
    control({
      action: "agent-register",
      participant: {
        id,
        name: `Agent-${id}`,
        kind: "agent",
        joinedAt: Date.now(),
        token: `tok-${id}`,
        capabilities: { text: true },
        ...(runtimeHost === undefined ? {} : { runtimeHost }),
      },
    })
  const humanRegister = () =>
    control({
      action: "register",
      participant: {
        id: "human-2",
        name: "Second Human",
        kind: "human",
        joinedAt: Date.now(),
        token: "tok-human-2",
        media: {
          sessionId: "dev-session",
          muted: false,
          fileChannelReady: true,
          tracks: [],
        },
        runtimeHost: VALID_HOST,
      },
    })
  const roomInfo = () => control({ action: "room-info" })
  const agentWait = (participantId: string) =>
    control({
      action: "agent-wait",
      participantId,
      token: `tok-${participantId}`,
      cursor: 0,
      timeoutSeconds: 0,
    })
  const storedParticipants = () =>
    (
      store.get("room") as {
        participants: Record<string, Record<string, unknown>>
      }
    ).participants
  return {
    control,
    agentRegister,
    humanRegister,
    roomInfo,
    agentWait,
    storedParticipants,
  }
}

describe("RoomSession Runtime Host projection (#176 Phase A)", () => {
  it("registers an Agent with a host projection and projects it in room-info and the wait roster", async () => {
    const room = makeRoomSession(buildStoredRoom())
    const registered = await room.agentRegister(VALID_HOST)
    expect(registered.status).toBe(200)
    expect(registered.json.participant).toMatchObject({
      runtimeHost: VALID_HOST,
    })

    const info = await room.roomInfo()
    const participants = info.json.participants as Array<
      Record<string, unknown>
    >
    const hosted = participants.find((p) => p.id === "agent-new")
    expect(hosted?.runtimeHost).toEqual(VALID_HOST)

    const roster = (await room.agentWait("agent-a")).json.participants as Array<
      Record<string, unknown>
    >
    expect(roster.find((p) => p.id === "agent-new")?.runtimeHost).toEqual(
      VALID_HOST
    )
    // Humans never project a host.
    expect(roster.find((p) => p.kind === "human")?.runtimeHost).toBeUndefined()
  })

  it("rejects malformed host projections and human projection registration", async () => {
    const room = makeRoomSession(buildStoredRoom())
    expect(
      (
        await room.agentRegister({
          runtimeHostId: "bad id!",
          speech: { stt: true, tts: true },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await room.agentRegister({
          runtimeHostId: "short",
          speech: { stt: true, tts: true },
        })
      ).status
    ).toBe(400)
    expect(
      (
        await room.agentRegister({
          runtimeHostId: VALID_HOST.runtimeHostId,
          speech: { stt: "yes", tts: true },
        })
      ).status
    ).toBe(400)
    expect((await room.agentRegister("not-an-object")).status).toBe(400)
    // Agents without a projection are unaffected (backward compatible).
    expect((await room.agentRegister()).status).toBe(200)
    // Humans may not project a Runtime Host at all.
    expect((await room.humanRegister()).status).toBe(400)
  })

  it("re-projects via agent-update-runtime-host with loud validation and auth", async () => {
    const room = makeRoomSession(buildStoredRoom())
    await room.agentRegister(VALID_HOST)

    const updated = await room.control({
      action: "agent-update-runtime-host",
      participantId: "agent-new",
      token: "tok-agent-new",
      runtimeHost: {
        runtimeHostId: "99999999-8888-7777-6666-555555555555",
        speech: { stt: false, tts: true },
      },
    })
    expect(updated.status).toBe(200)
    expect(room.storedParticipants()["agent-new"].runtimeHost).toEqual({
      runtimeHostId: "99999999-8888-7777-6666-555555555555",
      speech: { stt: false, tts: true },
    })

    // Wrong bearer capability: unauthorized.
    expect(
      (
        await room.control({
          action: "agent-update-runtime-host",
          participantId: "agent-new",
          token: "wrong-token",
          runtimeHost: VALID_HOST,
        })
      ).status
    ).toBe(401)

    // Humans can never use the agent-only action.
    expect(
      (
        await room.control({
          action: "agent-update-runtime-host",
          participantId: "human-1",
          token: "tok-h1",
          runtimeHost: VALID_HOST,
        })
      ).status
    ).toBe(403)

    // Malformed projection is rejected loudly, never repaired.
    expect(
      (
        await room.control({
          action: "agent-update-runtime-host",
          participantId: "agent-new",
          token: "tok-agent-new",
          runtimeHost: {
            runtimeHostId: "nope",
            speech: { stt: true, tts: true },
          },
        })
      ).status
    ).toBe(400)
    // The last valid projection survives the rejected update.
    expect(room.storedParticipants()["agent-new"].runtimeHost).toEqual({
      runtimeHostId: "99999999-8888-7777-6666-555555555555",
      speech: { stt: false, tts: true },
    })
  })

  it("drops a malformed persisted projection during room load and keeps absent ones absent", async () => {
    const room = makeRoomSession(
      buildStoredRoom({
        "agent-a": {
          runtimeHostId: "bad id with spaces",
          speech: { stt: true, tts: true },
        },
      })
    )
    const info = await room.roomInfo()
    const participants = info.json.participants as Array<
      Record<string, unknown>
    >
    expect(
      participants.find((p) => p.id === "agent-a")?.runtimeHost
    ).toBeUndefined()
    expect(
      participants.find((p) => p.id === "agent-b")?.runtimeHost
    ).toBeUndefined()
    // Storage was repaired too.
    expect(room.storedParticipants()["agent-a"].runtimeHost).toBeUndefined()
  })
})
