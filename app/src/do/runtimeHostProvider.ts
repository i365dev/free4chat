import { isValidRuntimeHostId, type RuntimeHostMap } from "./runtimeHost"
import { isRuntimeProviderClaimHash } from "../common/runtimeProviderCredential"
import type {
  ParticipantKind,
  PendingRuntimeHostProviderClaim,
  RuntimeHostProjection,
  RuntimeHostProviderAssociation,
  RuntimeHostProviderPublicAssociation,
} from "../room/types"

export const RUNTIME_PROVIDER_CLAIM_TTL_MS = 5 * 60 * 1000
export const MAX_PENDING_RUNTIME_PROVIDER_CLAIMS = 8
export const MAX_PENDING_RUNTIME_PROVIDER_CLAIMS_PER_HUMAN = 2

export interface RuntimeHostProviderParticipant {
  id: string
  kind: ParticipantKind
  connected?: boolean
}

export type RuntimeHostProviderMap = Record<
  string,
  RuntimeHostProviderAssociation
>
export type RuntimeHostProviderClaimMap = Record<
  string,
  PendingRuntimeHostProviderClaim
>

export interface RuntimeHostProviderNormalization {
  providers: RuntimeHostProviderMap
  pendingClaims: RuntimeHostProviderClaimMap
  changed: boolean
}

export type RuntimeHostProviderError =
  | "invalid_runtime_provider_claim"
  | "runtime_provider_claim_limit"
  | "runtime_provider_claim_not_found"
  | "runtime_provider_claim_expired"
  | "runtime_provider_claim_human_invalid"
  | "runtime_host_provider_already_bound"
  | "runtime_provider_proof_required"
  | "runtime_provider_handle_invalid"

function isCurrentHuman(
  participants: Iterable<RuntimeHostProviderParticipant>,
  participantId: string,
  requireConnected = false
): boolean {
  const participant = Array.from(participants).find(
    (candidate) => candidate.id === participantId
  )
  return (
    participant?.kind === "human" &&
    (!requireConnected || participant.connected === true)
  )
}

function validPendingClaim(
  value: unknown
): value is PendingRuntimeHostProviderClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<PendingRuntimeHostProviderClaim>
  return (
    typeof candidate.humanParticipantId === "string" &&
    candidate.humanParticipantId.length > 0 &&
    typeof candidate.expiresAt === "number" &&
    Number.isSafeInteger(candidate.expiresAt) &&
    candidate.expiresAt > 0
  )
}

function validProviderAssociation(
  value: unknown
): value is RuntimeHostProviderAssociation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<RuntimeHostProviderAssociation>
  return (
    typeof candidate.humanParticipantId === "string" &&
    candidate.humanParticipantId.length > 0 &&
    typeof candidate.claimedAt === "number" &&
    Number.isSafeInteger(candidate.claimedAt) &&
    candidate.claimedAt > 0 &&
    isRuntimeProviderClaimHash(candidate.providerHandleHash)
  )
}

export function normalizeRuntimeHostProviders({
  providers,
  pendingClaims,
  runtimeHosts,
  participants,
  now,
}: {
  providers: unknown
  pendingClaims: unknown
  runtimeHosts: RuntimeHostMap | undefined
  participants: Iterable<RuntimeHostProviderParticipant>
  now: number
}): RuntimeHostProviderNormalization {
  const participantList = Array.from(participants)
  const normalizedProviders: RuntimeHostProviderMap = {}
  const normalizedClaims: RuntimeHostProviderClaimMap = {}
  let changed = false

  if (typeof providers === "object" && providers && !Array.isArray(providers)) {
    for (const [hostId, association] of Object.entries(
      providers as Record<string, unknown>
    )) {
      if (
        !isValidRuntimeHostId(hostId) ||
        !runtimeHosts?.[hostId] ||
        !validProviderAssociation(association) ||
        !isCurrentHuman(participantList, association.humanParticipantId)
      ) {
        changed = true
        continue
      }
      normalizedProviders[hostId] = association
    }
  } else if (providers !== undefined) {
    changed = true
  }

  if (
    typeof pendingClaims === "object" &&
    pendingClaims &&
    !Array.isArray(pendingClaims)
  ) {
    for (const [claimHash, claim] of Object.entries(
      pendingClaims as Record<string, unknown>
    )) {
      if (
        !isRuntimeProviderClaimHash(claimHash) ||
        !validPendingClaim(claim) ||
        claim.expiresAt <= now ||
        !isCurrentHuman(participantList, claim.humanParticipantId)
      ) {
        changed = true
        continue
      }
      normalizedClaims[claimHash] = claim
    }
  } else if (pendingClaims !== undefined) {
    changed = true
  }

  if (
    Object.keys(normalizedProviders).length !==
      (providers && typeof providers === "object" && !Array.isArray(providers)
        ? Object.keys(providers).length
        : 0) ||
    Object.keys(normalizedClaims).length !==
      (pendingClaims &&
      typeof pendingClaims === "object" &&
      !Array.isArray(pendingClaims)
        ? Object.keys(pendingClaims).length
        : 0)
  )
    changed = true

  return {
    providers: normalizedProviders,
    pendingClaims: normalizedClaims,
    changed,
  }
}

export function createRuntimeHostProviderClaim({
  pendingClaims,
  participants,
  humanParticipantId,
  claimHash,
  now,
}: {
  pendingClaims: RuntimeHostProviderClaimMap
  participants: Iterable<RuntimeHostProviderParticipant>
  humanParticipantId: string
  claimHash: string
  now: number
}):
  | { ok: true; pendingClaims: RuntimeHostProviderClaimMap; expiresAt: number }
  | { ok: false; error: RuntimeHostProviderError } {
  if (!isRuntimeProviderClaimHash(claimHash))
    return { ok: false, error: "invalid_runtime_provider_claim" }
  if (!isCurrentHuman(participants, humanParticipantId, true))
    return { ok: false, error: "runtime_provider_claim_human_invalid" }
  const existing = pendingClaims[claimHash]
  if (existing) {
    if (existing.humanParticipantId !== humanParticipantId)
      return { ok: false, error: "invalid_runtime_provider_claim" }
    return { ok: true, pendingClaims, expiresAt: existing.expiresAt }
  }
  const countForHuman = Object.values(pendingClaims).filter(
    (claim) => claim.humanParticipantId === humanParticipantId
  ).length
  if (
    Object.keys(pendingClaims).length >= MAX_PENDING_RUNTIME_PROVIDER_CLAIMS ||
    countForHuman >= MAX_PENDING_RUNTIME_PROVIDER_CLAIMS_PER_HUMAN
  )
    return { ok: false, error: "runtime_provider_claim_limit" }
  const expiresAt = now + RUNTIME_PROVIDER_CLAIM_TTL_MS
  return {
    ok: true,
    pendingClaims: {
      ...pendingClaims,
      [claimHash]: { humanParticipantId, expiresAt },
    },
    expiresAt,
  }
}

export function redeemRuntimeHostProviderClaim({
  providers,
  pendingClaims,
  participants,
  runtimeHost,
  claimHash,
  providerHandleHash,
  now,
}: {
  providers: RuntimeHostProviderMap
  pendingClaims: RuntimeHostProviderClaimMap
  participants: Iterable<RuntimeHostProviderParticipant>
  runtimeHost: RuntimeHostProjection
  claimHash: string
  providerHandleHash: string
  now: number
}):
  | {
      ok: true
      providers: RuntimeHostProviderMap
      pendingClaims: RuntimeHostProviderClaimMap
      association: RuntimeHostProviderAssociation
    }
  | { ok: false; error: RuntimeHostProviderError } {
  const claim = pendingClaims[claimHash]
  if (!claim) return { ok: false, error: "runtime_provider_claim_not_found" }
  if (claim.expiresAt <= now)
    return { ok: false, error: "runtime_provider_claim_expired" }
  if (!isCurrentHuman(participants, claim.humanParticipantId))
    return { ok: false, error: "runtime_provider_claim_human_invalid" }
  if (providers[runtimeHost.runtimeHostId])
    return { ok: false, error: "runtime_host_provider_already_bound" }
  if (!isRuntimeProviderClaimHash(providerHandleHash))
    return { ok: false, error: "runtime_provider_handle_invalid" }

  const association: RuntimeHostProviderAssociation = {
    humanParticipantId: claim.humanParticipantId,
    claimedAt: now,
    providerHandleHash,
  }
  const { [claimHash]: _consumed, ...remainingClaims } = pendingClaims
  return {
    ok: true,
    providers: {
      ...providers,
      [runtimeHost.runtimeHostId]: association,
    },
    pendingClaims: remainingClaims,
    association,
  }
}

// An unbound Runtime Host keeps Phase-A discovery semantics. Once bound, all
// updates that could change the authorization-relevant readiness projection
// must prove possession of the private handle that redeemed the Human claim.
export function verifyRuntimeHostProviderProof({
  providers,
  runtimeHostId,
  providerHandleHash,
}: {
  providers: RuntimeHostProviderMap
  runtimeHostId: string
  providerHandleHash?: string
}): { ok: true } | { ok: false; error: RuntimeHostProviderError } {
  const association = providers[runtimeHostId]
  if (!association) {
    return providerHandleHash
      ? { ok: false, error: "runtime_provider_handle_invalid" }
      : { ok: true }
  }
  if (!providerHandleHash)
    return { ok: false, error: "runtime_provider_proof_required" }
  return association.providerHandleHash === providerHandleHash
    ? { ok: true }
    : { ok: false, error: "runtime_provider_handle_invalid" }
}

export function removeRuntimeHostProviderForHuman({
  providers,
  pendingClaims,
  humanParticipantId,
}: {
  providers: RuntimeHostProviderMap
  pendingClaims: RuntimeHostProviderClaimMap
  humanParticipantId: string
}): {
  providers: RuntimeHostProviderMap
  pendingClaims: RuntimeHostProviderClaimMap
  changed: boolean
} {
  let changed = false
  const nextProviders: RuntimeHostProviderMap = {}
  const nextClaims: RuntimeHostProviderClaimMap = {}
  for (const [hostId, association] of Object.entries(providers)) {
    if (association.humanParticipantId === humanParticipantId) {
      changed = true
      continue
    }
    nextProviders[hostId] = association
  }
  for (const [claimHash, claim] of Object.entries(pendingClaims)) {
    if (claim.humanParticipantId === humanParticipantId) {
      changed = true
      continue
    }
    nextClaims[claimHash] = claim
  }
  return { providers: nextProviders, pendingClaims: nextClaims, changed }
}

export function garbageCollectRuntimeHostProviders({
  providers,
  runtimeHosts,
}: {
  providers: RuntimeHostProviderMap
  runtimeHosts: RuntimeHostMap | undefined
}): RuntimeHostProviderMap {
  const next: RuntimeHostProviderMap = {}
  for (const [hostId, association] of Object.entries(providers))
    if (runtimeHosts?.[hostId]) next[hostId] = association
  return next
}

export function projectRuntimeHostProviders(
  providers: RuntimeHostProviderMap | undefined
): Record<string, RuntimeHostProviderPublicAssociation> {
  const projection: Record<string, RuntimeHostProviderPublicAssociation> = {}
  for (const [hostId, association] of Object.entries(providers ?? {}))
    projection[hostId] = {
      humanParticipantId: association.humanParticipantId,
      claimedAt: association.claimedAt,
    }
  return projection
}

// The small #177-facing predicate: a current Human can use a Runtime Host's
// requested speech capability only if this Room has a live explicit provider
// association for the same Human. Voice remains intentionally outside it.
export function canHumanUseRuntimeHost({
  participants,
  runtimeHosts,
  providers,
  humanParticipantId,
  runtimeHostId,
  requiredSpeech,
}: {
  participants: Iterable<RuntimeHostProviderParticipant>
  runtimeHosts: RuntimeHostMap | undefined
  providers: RuntimeHostProviderMap | undefined
  humanParticipantId: string
  runtimeHostId: string
  requiredSpeech: "stt" | "tts"
}): boolean {
  if (!isCurrentHuman(participants, humanParticipantId, true)) return false
  const host = runtimeHosts?.[runtimeHostId]
  const association = providers?.[runtimeHostId]
  return (
    Boolean(host?.speech[requiredSpeech]) &&
    association?.humanParticipantId === humanParticipantId
  )
}
