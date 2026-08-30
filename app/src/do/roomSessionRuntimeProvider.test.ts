import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import { deriveRuntimeProviderClaimHash } from "../common/runtimeProviderCredential"

const host = {
  runtimeHostId: "host-176-provider",
  speech: { stt: true, tts: false },
}
const claimSecret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

function human(id: string) {
  return {
    id,
    name: id,
    kind: "human" as const,
    connected: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    token: `${id}-token`,
    media: {
      sessionId: `${id}-session`,
      muted: false,
      fileChannelReady: false,
      tracks: [],
    },
  }
}

function harness() {
  const store = new Map<string, unknown>([
    [
      "room",
      {
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        participants: { human: human("human"), other: human("other") },
        runtimeHosts: {},
        messages: [],
        attachments: [],
        nextMessageSequence: 0,
        meetingNotes: { active: false },
        agentVoice: {},
        pendingMediaCleanup: [],
      },
    ],
  ])
  const ctx = {
    id: { toString: () => "room-do-scope" },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async () => undefined,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [] as WebSocket[],
  }
  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  vi.spyOn(session as any, "broadcastState").mockResolvedValue(undefined)
  vi.spyOn(session as any, "scheduleNextAlarm").mockResolvedValue(undefined)
  vi.spyOn(session as any, "attemptCleanupNow").mockResolvedValue(undefined)
  const socket = { send: vi.fn(), close: vi.fn() }
  const control = async (body: Record<string, unknown>) => {
    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
    return { status: response.status, json: await response.json() }
  }
  const sendHuman = (id: string, message: object) =>
    (session as any).handleClientMessage(
      socket,
      { participantId: id, token: `${id}-token`, connectionNonce: "n" },
      message
    )
  return { store, socket, control, sendHuman }
}

describe("RoomSession Runtime Host provider authorization (#176 Phase B)", () => {
  it("atomically consumes a Human claim, requires Host-specific proof, and keeps credentials private", async () => {
    const room = harness()
    const claimHash = await deriveRuntimeProviderClaimHash(
      "room-176-provider",
      claimSecret
    )
    await room.sendHuman("human", {
      type: "runtime-provider-claim-create",
      requestId: "claim-1",
      providerClaimHash: claimHash,
    })
    expect((room.store.get("room") as any).nextMessageSequence).toBe(0)
    expect(
      (room.store.get("room") as any).runtimeHostProviderClaims
    ).toHaveProperty(claimHash)

    const redeemed = await room.control({
      action: "agent-register",
      participant: {
        id: "pi",
        name: "Pi",
        kind: "agent",
        joinedAt: Date.now(),
        token: "pi-token",
        capabilities: { text: true },
        runtimeHost: host,
        providerClaimHash: claimHash,
      },
    })
    expect(redeemed.status).toBe(200)
    const providerHandle = (redeemed.json as any)
      .runtimeProviderHandle as string
    expect(providerHandle).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const stored = room.store.get("room") as any
    expect(stored.runtimeHostProviderClaims).toEqual({})
    expect(stored.runtimeHostProviders[host.runtimeHostId]).toEqual(
      expect.objectContaining({ humanParticipantId: "human" })
    )
    expect(JSON.stringify(stored.runtimeHostProviders)).not.toContain(
      providerHandle
    )

    const provenSameHost = await room.control({
      action: "agent-register",
      participant: {
        id: "codex",
        name: "Codex",
        kind: "agent",
        joinedAt: Date.now(),
        token: "codex-token",
        capabilities: { text: true },
        runtimeHost: host,
        runtimeProviderHandle: providerHandle,
      },
    })
    expect(provenSameHost.status).toBe(200)
    expect(
      (room.store.get("room") as any).runtimeHostProviders[host.runtimeHostId]
        .verifiedParticipantIds
    ).toEqual(["pi", "codex"])

    const copiedHostId = await room.control({
      action: "agent-register",
      participant: {
        id: "spoofed-host",
        name: "Spoofed host",
        kind: "agent",
        joinedAt: Date.now(),
        token: "spoofed-host-token",
        capabilities: { text: true },
        runtimeHost: host,
      },
    })
    expect(copiedHostId).toMatchObject({
      status: 403,
      json: { error: "runtime_provider_proof_required" },
    })

    const spoof = await room.control({
      action: "agent-update-runtime-host",
      participantId: "pi",
      token: "pi-token",
      runtimeHost: host,
    })
    expect(spoof).toMatchObject({
      status: 403,
      json: { error: "runtime_provider_proof_required" },
    })
    const approved = await room.control({
      action: "agent-update-runtime-host",
      participantId: "pi",
      token: "pi-token",
      runtimeHost: { ...host, speech: { stt: false, tts: true } },
      runtimeProviderHandle: providerHandle,
    })
    expect(approved.status).toBe(200)

    const info = await room.control({ action: "room-info" })
    expect((info.json as any).runtimeHostProviders).toEqual({
      [host.runtimeHostId]: expect.objectContaining({
        humanParticipantId: "human",
      }),
    })
    expect(JSON.stringify(info.json)).not.toContain(claimHash)
    expect(JSON.stringify(info.json)).not.toContain(providerHandle)
    expect(JSON.stringify(info.json)).not.toContain("providerHandleHash")
  })

  it("does not let another Human claim the same hash and revokes association on true leave", async () => {
    const room = harness()
    const claimHash = await deriveRuntimeProviderClaimHash(
      "room-176-provider",
      claimSecret
    )
    await room.sendHuman("human", {
      type: "runtime-provider-claim-create",
      requestId: "claim-human",
      providerClaimHash: claimHash,
    })
    await room.sendHuman("other", {
      type: "runtime-provider-claim-create",
      requestId: "claim-other",
      providerClaimHash: claimHash,
    })
    expect(room.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "error", error: "invalid_runtime_provider_claim" })
    )

    const redeemed = await room.control({
      action: "agent-register",
      participant: {
        id: "pi",
        name: "Pi",
        kind: "agent",
        joinedAt: Date.now(),
        token: "pi-token",
        capabilities: { text: true },
        runtimeHost: host,
        providerClaimHash: claimHash,
      },
    })
    expect(redeemed.status).toBe(200)
    await room.sendHuman("human", { type: "leave" })
    const stored = room.store.get("room") as any
    expect(stored.runtimeHostProviders).toEqual({})
    expect(stored.runtimeHostProviderClaims).toEqual({})
  })

  it("does not let a pre-binding copied Host id keep a provider association alive", async () => {
    const room = harness()
    // Before a Human claim is redeemed, discovery remains Phase-A compatible:
    // a second Runtime can advertise the same public Host id without proving
    // a capability. It must never become a provider member by doing so.
    const copiedBeforeBinding = await room.control({
      action: "agent-register",
      participant: {
        id: "spoofed",
        name: "Spoofed host",
        kind: "agent",
        joinedAt: Date.now(),
        token: "spoofed-token",
        capabilities: { text: true },
        runtimeHost: host,
      },
    })
    expect(copiedBeforeBinding.status).toBe(200)

    const claimHash = await deriveRuntimeProviderClaimHash(
      "room-176-provider",
      claimSecret
    )
    await room.sendHuman("human", {
      type: "runtime-provider-claim-create",
      requestId: "claim-proof-membership",
      providerClaimHash: claimHash,
    })
    const redeemed = await room.control({
      action: "agent-register",
      participant: {
        id: "legitimate",
        name: "Legitimate host",
        kind: "agent",
        joinedAt: Date.now(),
        token: "legitimate-token",
        capabilities: { text: true },
        runtimeHost: host,
        providerClaimHash: claimHash,
      },
    })
    expect(redeemed.status).toBe(200)
    const storedAfterRedeem = room.store.get("room") as any
    expect(
      storedAfterRedeem.runtimeHostProviders[host.runtimeHostId]
        .verifiedParticipantIds
    ).toEqual(["legitimate"])

    const leave = await room.control({
      action: "agent-leave",
      participantId: "legitimate",
      token: "legitimate-token",
    })
    expect(leave.status).toBe(200)
    const storedAfterLeave = room.store.get("room") as any
    // The public Host projection survives because the spoofing participant is
    // still in the room, but the Human provider association does not.
    expect(storedAfterLeave.runtimeHosts).toHaveProperty(host.runtimeHostId)
    expect(storedAfterLeave.runtimeHostProviders).toEqual({})

    // The remaining Phase-A participant may hot-reload ordinary discovery,
    // but it cannot revive the revoked Human provider association.
    const ordinaryProjection = await room.control({
      action: "agent-update-runtime-host",
      participantId: "spoofed",
      token: "spoofed-token",
      runtimeHost: { ...host, speech: { stt: false, tts: true } },
    })
    expect(ordinaryProjection.status).toBe(200)
    const info = await room.control({ action: "room-info" })
    expect((info.json as any).runtimeHostProviders).toEqual({})
  })
})
