import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

// #176 Phase A (canonical Room model, #178 review): one coarse readiness
// projection per Runtime Host id in RoomRecord.runtimeHosts, referenced by
// participants via runtimeHostId. Tests cover register/update projections,
// shared readiness for same-host Agents, hot reload, persistence + storage
// hygiene, and garbage collection on departure.

const VALID_HOST = {
  runtimeHostId: "11111111-2222-3333-4444-555555555555",
  speech: { stt: true, tts: false },
}

function buildStoredRoom(
  agentRuntimeHostIds: Record<string, string | undefined> = {},
  runtimeHosts?: Record<string, unknown>
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
            ...(agentRuntimeHostIds[id] !== undefined
              ? { runtimeHostId: agentRuntimeHostIds[id] }
              : {}),
          },
        ])
      ),
    },
    ...(runtimeHosts === undefined ? {} : { runtimeHosts }),
    messages: [],
    nextMessageSequence: 1,
    meetingNotes: { active: false },
    voiceReply: { active: false },
    pendingMediaCleanup: [],
  }
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
  const storedRuntimeHosts = () =>
    ((store.get("room") as { runtimeHosts?: Record<string, unknown> })
      .runtimeHosts ?? {}) as Record<string, unknown>
  return {
    control,
    agentRegister,
    humanRegister,
    roomInfo,
    agentWait,
    storedParticipants,
    storedRuntimeHosts,
  }
}

describe("RoomSession Runtime Host canonical model (#176 Phase A)", () => {
  it("registers an Agent with a host projection: map + participant id + projections", async () => {
    const room = makeRoomSession(buildStoredRoom())
    const registered = await room.agentRegister(VALID_HOST)
    expect(registered.status).toBe(200)
    // Participant references the host id; readiness lives in the map.
    expect(registered.json.participant).toMatchObject({
      runtimeHostId: VALID_HOST.runtimeHostId,
    })
    expect(room.storedParticipants()["agent-new"].runtimeHostId).toBe(
      VALID_HOST.runtimeHostId
    )
    expect(room.storedRuntimeHosts()).toEqual({
      [VALID_HOST.runtimeHostId]: VALID_HOST,
    })

    const info = await room.roomInfo()
    const participants = info.json.participants as Array<
      Record<string, unknown>
    >
    expect(participants.find((p) => p.id === "agent-new")?.runtimeHostId).toBe(
      VALID_HOST.runtimeHostId
    )
    expect(info.json.runtimeHosts).toEqual({
      [VALID_HOST.runtimeHostId]: VALID_HOST,
    })

    const wait = (await room.agentWait("agent-a")).json
    const roster = wait.participants as Array<Record<string, unknown>>
    expect(roster.find((p) => p.id === "agent-new")?.runtimeHostId).toBe(
      VALID_HOST.runtimeHostId
    )
    expect(wait.runtimeHosts).toEqual({
      [VALID_HOST.runtimeHostId]: VALID_HOST,
    })
    // Humans never project a host.
    expect(
      roster.find((p) => p.kind === "human")?.runtimeHostId
    ).toBeUndefined()
  })

  it("two Agents of the same host share ONE readiness projection; hot reload updates it for both", async () => {
    const room = makeRoomSession(buildStoredRoom())
    await room.agentRegister(VALID_HOST, "agent-a2")
    await room.agentRegister(VALID_HOST, "agent-b2")
    // Same host id registered twice: still exactly ONE stored projection.
    expect(Object.keys(room.storedRuntimeHosts()).length).toBe(1)
    expect(room.storedParticipants()["agent-a2"].runtimeHostId).toBe(
      VALID_HOST.runtimeHostId
    )
    expect(room.storedParticipants()["agent-b2"].runtimeHostId).toBe(
      VALID_HOST.runtimeHostId
    )

    // Hot reload via the FIRST agent updates the shared readiness both
    // agents project.
    const updated = await room.control({
      action: "agent-update-runtime-host",
      participantId: "agent-a2",
      token: "tok-agent-a2",
      runtimeHost: {
        runtimeHostId: VALID_HOST.runtimeHostId,
        speech: { stt: false, tts: true },
      },
    })
    expect(updated.status).toBe(200)
    expect(room.storedRuntimeHosts()[VALID_HOST.runtimeHostId]).toEqual({
      runtimeHostId: VALID_HOST.runtimeHostId,
      speech: { stt: false, tts: true },
    })
  })

  it("malformed registration projections are additive: dropped, join proceeds", async () => {
    const room = makeRoomSession(buildStoredRoom())
    // #178 review fix 5: a malformed projection must never block a text
    // join — it is dropped (no host stored) and the Agent registers fine.
    const badPayloads = [
      { runtimeHostId: "bad id!", speech: { stt: true, tts: true } },
      { runtimeHostId: "short", speech: { stt: true, tts: true } },
      {
        runtimeHostId: VALID_HOST.runtimeHostId,
        speech: { stt: "yes", tts: true },
      },
      "not-an-object",
    ]
    let counter = 0
    for (const bad of badPayloads) {
      counter += 1
      const result = await room.agentRegister(bad, `agent-bad-${counter}`)
      expect(result.status).toBe(200)
      expect(
        (result.json.participant as Record<string, unknown>).runtimeHostId
      ).toBeUndefined()
    }
    expect(Object.keys(room.storedRuntimeHosts()).length).toBe(0)
    // Agents without a projection are unaffected (backward compatible).
    expect((await room.agentRegister()).status).toBe(200)
    // Humans never project a host: their registration payload is dropped
    // (additive semantics — the join itself must never block).
    const human = await room.humanRegister()
    expect(human.status).toBe(200)
    const afterHuman = (await room.roomInfo()).json.participants as Array<
      Record<string, unknown>
    >
    expect(
      afterHuman.find((p) => p.id === "human-2")?.runtimeHostId
    ).toBeUndefined()
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
    expect(room.storedParticipants()["agent-new"].runtimeHostId).toBe(
      "99999999-8888-7777-6666-555555555555"
    )
    expect(room.storedRuntimeHosts()).toEqual({
      "99999999-8888-7777-6666-555555555555": {
        runtimeHostId: "99999999-8888-7777-6666-555555555555",
        speech: { stt: false, tts: true },
      },
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

    // Malformed projection is rejected loudly on the UPDATE op, never
    // repaired; the last valid projection survives the rejected update.
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
    expect(room.storedRuntimeHosts()).toEqual({
      "99999999-8888-7777-6666-555555555555": {
        runtimeHostId: "99999999-8888-7777-6666-555555555555",
        speech: { stt: false, tts: true },
      },
    })
  })

  it("garbage-collects host projections when their last Agent departs, keeps shared hosts", async () => {
    const room = makeRoomSession(buildStoredRoom())
    await room.agentRegister(VALID_HOST, "agent-a2")
    await room.agentRegister(VALID_HOST, "agent-b2")
    expect(Object.keys(room.storedRuntimeHosts()).length).toBe(1)

    // First Agent leaves: the host is still referenced by agent-b2.
    await room.control({
      action: "agent-leave",
      participantId: "agent-a2",
      token: "tok-agent-a2",
    })
    expect(Object.keys(room.storedRuntimeHosts()).length).toBe(1)

    // Last referencing Agent leaves: the host projection is collected.
    await room.control({
      action: "agent-leave",
      participantId: "agent-b2",
      token: "tok-agent-b2",
    })
    expect(Object.keys(room.storedRuntimeHosts()).length).toBe(0)
  })

  it("persists runtimeHosts across loads and sanitizes malformed storage", async () => {
    const storedHost = {
      runtimeHostId: VALID_HOST.runtimeHostId,
      speech: { stt: true, tts: false },
    }
    const stored = buildStoredRoom(
      {
        "agent-a": VALID_HOST.runtimeHostId,
        "agent-b": "ghost-host-id",
      },
      {
        [VALID_HOST.runtimeHostId]: storedHost,
        "bad id!": {
          runtimeHostId: "bad id!",
          speech: { stt: true, tts: true },
        },
      }
    )
    const room = makeRoomSession(stored)

    const info = await room.roomInfo()
    // Valid entry survived the load; malformed entry dropped.
    expect(info.json.runtimeHosts).toEqual({
      [VALID_HOST.runtimeHostId]: storedHost,
    })
    const participants = info.json.participants as Array<
      Record<string, unknown>
    >
    // Valid reference kept; dangling reference cleared.
    expect(participants.find((p) => p.id === "agent-a")?.runtimeHostId).toBe(
      VALID_HOST.runtimeHostId
    )
    expect(
      participants.find((p) => p.id === "agent-b")?.runtimeHostId
    ).toBeUndefined()
    // Storage repaired.
    expect(room.storedRuntimeHosts()).toEqual({
      [VALID_HOST.runtimeHostId]: storedHost,
    })
    expect(room.storedParticipants()["agent-b"].runtimeHostId).toBeUndefined()
  })
})
