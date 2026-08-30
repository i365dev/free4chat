import { describe, expect, it } from "vitest"

import {
  MAX_PENDING_RUNTIME_PROVIDER_CLAIMS_PER_HUMAN,
  canHumanUseRuntimeHost,
  createRuntimeHostProviderClaim,
  garbageCollectRuntimeHostProviders,
  redeemRuntimeHostProviderClaim,
  removeRuntimeHostProviderForHuman,
  verifyRuntimeHostProviderProof,
} from "./runtimeHostProvider"

const now = 1_700_000_000_000
const claimA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const claimB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const handleA = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
const hostA = {
  runtimeHostId: "host-provider-a",
  speech: { stt: true, tts: false },
}
const hostB = {
  runtimeHostId: "host-provider-b",
  speech: { stt: true, tts: false },
}
const humans = [
  { id: "dawei", kind: "human" as const, connected: true },
  { id: "alice", kind: "human" as const, connected: true },
]
const verifiedAgents = [
  { id: "pi", kind: "agent" as const, runtimeHostId: hostA.runtimeHostId },
  {
    id: "hermes",
    kind: "agent" as const,
    runtimeHostId: hostB.runtimeHostId,
  },
]

describe("Runtime Host provider authorization", () => {
  it("redeems one Human-created claim exactly once into one host association", () => {
    const created = createRuntimeHostProviderClaim({
      pendingClaims: {},
      participants: humans,
      humanParticipantId: "dawei",
      claimHash: claimA,
      now,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const redeemed = redeemRuntimeHostProviderClaim({
      providers: {},
      pendingClaims: created.pendingClaims,
      participants: humans,
      runtimeHost: hostA,
      claimHash: claimA,
      providerHandleHash: handleA,
      verifiedParticipantId: "pi",
      now: now + 1,
    })
    expect(redeemed).toMatchObject({
      ok: true,
      providers: {
        [hostA.runtimeHostId]: {
          humanParticipantId: "dawei",
          providerHandleHash: handleA,
          verifiedParticipantIds: ["pi"],
        },
      },
      pendingClaims: {},
    })
    if (!redeemed.ok) return
    expect(
      redeemRuntimeHostProviderClaim({
        providers: redeemed.providers,
        pendingClaims: redeemed.pendingClaims,
        participants: humans,
        runtimeHost: hostB,
        claimHash: claimA,
        providerHandleHash: handleA,
        verifiedParticipantId: "pi",
        now: now + 2,
      })
    ).toEqual({ ok: false, error: "runtime_provider_claim_not_found" })
  })

  it("rejects unknown, expired, and another Human's malformed redemption", () => {
    expect(
      redeemRuntimeHostProviderClaim({
        providers: {},
        pendingClaims: {},
        participants: humans,
        runtimeHost: hostA,
        claimHash: claimA,
        providerHandleHash: handleA,
        verifiedParticipantId: "pi",
        now,
      })
    ).toEqual({ ok: false, error: "runtime_provider_claim_not_found" })
    expect(
      redeemRuntimeHostProviderClaim({
        providers: {},
        pendingClaims: {
          [claimA]: { humanParticipantId: "dawei", expiresAt: now },
        },
        participants: humans,
        runtimeHost: hostA,
        claimHash: claimA,
        providerHandleHash: handleA,
        verifiedParticipantId: "pi",
        now,
      })
    ).toEqual({ ok: false, error: "runtime_provider_claim_expired" })
    const leftHumans = humans.filter((human) => human.id !== "dawei")
    expect(
      redeemRuntimeHostProviderClaim({
        providers: {},
        pendingClaims: {
          [claimA]: { humanParticipantId: "dawei", expiresAt: now + 1 },
        },
        participants: leftHumans,
        runtimeHost: hostA,
        claimHash: claimA,
        providerHandleHash: handleA,
        verifiedParticipantId: "pi",
        now,
      })
    ).toEqual({ ok: false, error: "runtime_provider_claim_human_invalid" })
  })

  it("requires the private proof after a host is bound", () => {
    const providers = {
      [hostA.runtimeHostId]: {
        humanParticipantId: "dawei",
        claimedAt: now,
        providerHandleHash: handleA,
        verifiedParticipantIds: ["pi"],
      },
    }
    expect(
      verifyRuntimeHostProviderProof({
        providers,
        runtimeHostId: hostA.runtimeHostId,
      })
    ).toEqual({ ok: false, error: "runtime_provider_proof_required" })
    expect(
      verifyRuntimeHostProviderProof({
        providers,
        runtimeHostId: hostA.runtimeHostId,
        providerHandleHash: claimB,
      })
    ).toEqual({ ok: false, error: "runtime_provider_handle_invalid" })
    expect(
      verifyRuntimeHostProviderProof({
        providers,
        runtimeHostId: hostA.runtimeHostId,
        providerHandleHash: handleA,
      })
    ).toEqual({ ok: true })
    // A Host A handle never authorizes a new unbound Host B projection.
    expect(
      verifyRuntimeHostProviderProof({
        providers,
        runtimeHostId: hostB.runtimeHostId,
        providerHandleHash: handleA,
      })
    ).toEqual({ ok: false, error: "runtime_provider_handle_invalid" })
  })

  it("keeps Human-to-host STT use isolated and cleans up on leave/host GC", () => {
    const providers = {
      [hostA.runtimeHostId]: {
        humanParticipantId: "dawei",
        claimedAt: now,
        providerHandleHash: handleA,
        verifiedParticipantIds: ["pi"],
      },
      [hostB.runtimeHostId]: {
        humanParticipantId: "alice",
        claimedAt: now,
        providerHandleHash: claimB,
        verifiedParticipantIds: ["hermes"],
      },
    }
    const runtimeHosts = {
      [hostA.runtimeHostId]: hostA,
      [hostB.runtimeHostId]: hostB,
    }
    expect(
      canHumanUseRuntimeHost({
        participants: [...humans, ...verifiedAgents],
        runtimeHosts,
        providers,
        humanParticipantId: "dawei",
        runtimeHostId: hostA.runtimeHostId,
        requiredSpeech: "stt",
      })
    ).toBe(true)
    expect(
      canHumanUseRuntimeHost({
        participants: [...humans, ...verifiedAgents],
        runtimeHosts,
        providers,
        humanParticipantId: "dawei",
        runtimeHostId: hostB.runtimeHostId,
        requiredSpeech: "stt",
      })
    ).toBe(false)
    const afterLeave = removeRuntimeHostProviderForHuman({
      providers,
      pendingClaims: {
        [claimA]: { humanParticipantId: "dawei", expiresAt: now + 1000 },
      },
      humanParticipantId: "dawei",
    })
    expect(afterLeave.providers[hostA.runtimeHostId]).toBeUndefined()
    expect(afterLeave.pendingClaims).toEqual({})
    expect(
      garbageCollectRuntimeHostProviders({
        providers,
        runtimeHosts: { [hostA.runtimeHostId]: hostA },
        participants: [...humans, ...verifiedAgents],
      })
    ).toEqual({ [hostA.runtimeHostId]: providers[hostA.runtimeHostId] })
  })

  it("does not keep a Human binding alive through an unproved copied host id", () => {
    const providers = {
      [hostA.runtimeHostId]: {
        humanParticipantId: "dawei",
        claimedAt: now,
        providerHandleHash: handleA,
        // Only the claim redeemer proved the private handle. The other Agent
        // copied the public Host id before this binding existed.
        verifiedParticipantIds: ["legitimate"],
      },
    }
    const runtimeHosts = { [hostA.runtimeHostId]: hostA }
    const afterRedeemerLeaves = garbageCollectRuntimeHostProviders({
      providers,
      runtimeHosts,
      participants: [
        ...humans,
        {
          id: "spoofed",
          kind: "agent" as const,
          runtimeHostId: hostA.runtimeHostId,
        },
      ],
    })
    expect(afterRedeemerLeaves).toEqual({})
    expect(
      canHumanUseRuntimeHost({
        participants: [
          ...humans,
          {
            id: "spoofed",
            kind: "agent" as const,
            runtimeHostId: hostA.runtimeHostId,
          },
        ],
        runtimeHosts,
        providers: afterRedeemerLeaves,
        humanParticipantId: "dawei",
        runtimeHostId: hostA.runtimeHostId,
        requiredSpeech: "stt",
      })
    ).toBe(false)
  })

  it("bounds pending claim admission without producing Room messages", () => {
    let pending: Record<
      string,
      { humanParticipantId: string; expiresAt: number }
    > = {}
    for (
      let index = 0;
      index < MAX_PENDING_RUNTIME_PROVIDER_CLAIMS_PER_HUMAN;
      index += 1
    ) {
      const claim = `${String(index).padEnd(43, "A")}`
      const created = createRuntimeHostProviderClaim({
        pendingClaims: pending,
        participants: humans,
        humanParticipantId: "dawei",
        claimHash: claim,
        now,
      })
      expect(created.ok).toBe(true)
      if (created.ok) pending = created.pendingClaims
    }
    expect(
      createRuntimeHostProviderClaim({
        pendingClaims: pending,
        participants: humans,
        humanParticipantId: "dawei",
        claimHash: claimB,
        now,
      })
    ).toEqual({ ok: false, error: "runtime_provider_claim_limit" })
  })
})
