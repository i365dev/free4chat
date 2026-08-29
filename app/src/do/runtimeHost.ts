import type {
  ParticipantKind,
  RoomParticipant,
  RuntimeHostProjection,
} from "../room/types"

// Runtime Host identity is an opaque, bounded token. The Runtime derives the
// room-scoped value locally; the Room only validates and stores the
// secret-free projection below.
export const RUNTIME_HOST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/

export interface RuntimeHostValidationResult {
  ok: boolean
  runtimeHost?: RuntimeHostProjection
  error?: string
  reason?: string
}

export type RuntimeHostMap = Record<string, RuntimeHostProjection>

/** The participant fields Runtime Host transitions are allowed to inspect. */
export interface RuntimeHostParticipant {
  id: string
  kind: ParticipantKind
  runtimeHostId?: string
}

export interface RuntimeHostNormalization {
  runtimeHosts: RuntimeHostMap
  // RoomSession owns the complete participant records, so normalization
  // reports only which references must be removed rather than mutating them.
  danglingParticipantIds: string[]
  changed: boolean
}

export interface RuntimeHostUpdate {
  runtimeHosts: RuntimeHostMap
  previousHostId?: string
  previousProjection?: RuntimeHostProjection
}

export function isValidRuntimeHostId(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_HOST_ID_PATTERN.test(value)
}

// #176 Phase A: the only accepted Runtime Host wire projection. This carries
// readiness booleans only; provider, credential and device details never enter
// Room state.
export function validateRuntimeHost(
  input: unknown
): RuntimeHostValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return {
      ok: false,
      error: "invalid_runtime_host",
      reason: "must_be_object",
    }
  const candidate = input as Record<string, unknown>
  const runtimeHostId = candidate.runtimeHostId
  if (!isValidRuntimeHostId(runtimeHostId))
    return {
      ok: false,
      error: "invalid_runtime_host",
      reason: "invalid_runtime_host_id",
    }
  const speech = candidate.speech
  if (typeof speech !== "object" || speech === null || Array.isArray(speech))
    return {
      ok: false,
      error: "invalid_runtime_host",
      reason: "invalid_speech",
    }
  const slots = (speech as Record<string, unknown>).stt
  const voice = (speech as Record<string, unknown>).tts
  if (typeof slots !== "boolean" || typeof voice !== "boolean")
    return {
      ok: false,
      error: "invalid_runtime_host",
      reason: "invalid_speech",
    }
  return {
    ok: true,
    runtimeHost: {
      runtimeHostId,
      speech: { stt: slots, tts: voice },
    },
  }
}

/** Storage hygiene for one persisted projection: malformed state is dropped. */
export function sanitizeStoredRuntimeHost(
  input: unknown
): RuntimeHostProjection | undefined {
  const validated = validateRuntimeHost(input)
  return validated.ok ? validated.runtimeHost : undefined
}

/**
 * Sanitize the canonical map and find participant references that no longer
 * resolve to a valid projection. This is deliberately pure so loading a Room
 * can decide persistence separately from the domain repair decision.
 */
export function normalizeRuntimeHosts(
  input: unknown,
  participants: Iterable<RuntimeHostParticipant>
): RuntimeHostNormalization {
  const runtimeHosts = sanitizeStoredRuntimeHosts(input)
  let changed = false

  // Preserve the existing storage-repair contract: undefined/null means the
  // legacy field was absent, while any non-null map with dropped entries is
  // persisted as repaired state.
  if (input !== undefined && input !== null) {
    let rawEntryCount = 0
    try {
      rawEntryCount = Object.keys(input as object).length
    } catch {
      // Object.keys currently accepts every value except null/undefined, but
      // keep normalization fail-closed if that runtime behavior changes.
    }
    if (Object.keys(runtimeHosts).length !== rawEntryCount) changed = true
  }

  const danglingParticipantIds: string[] = []
  for (const participant of participants) {
    if (
      participant.runtimeHostId !== undefined &&
      (!isValidRuntimeHostId(participant.runtimeHostId) ||
        runtimeHosts[participant.runtimeHostId] === undefined)
    ) {
      danglingParticipantIds.push(participant.id)
      changed = true
    }
  }

  return { runtimeHosts, danglingParticipantIds, changed }
}

/** Storage hygiene for a canonical map: invalid entries are never repaired. */
export function sanitizeStoredRuntimeHosts(input: unknown): RuntimeHostMap {
  const hosts: RuntimeHostMap = {}
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return hosts
  for (const [hostId, raw] of Object.entries(
    input as Record<string, unknown>
  )) {
    if (!isValidRuntimeHostId(hostId)) continue
    const validated = validateRuntimeHost({
      runtimeHostId: hostId,
      ...(typeof raw === "object" && raw !== null
        ? { speech: (raw as Record<string, unknown>).speech }
        : {}),
    })
    if (validated.ok && validated.runtimeHost)
      hosts[hostId] = validated.runtimeHost
  }
  return hosts
}

/** Return the room-facing projection shape without leaking internal details. */
export function projectRuntimeHosts(
  runtimeHosts?: RuntimeHostMap
): RuntimeHostMap {
  return runtimeHosts ?? {}
}

/** Register or replace the one shared projection for a host id. */
export function registerRuntimeHost(
  runtimeHosts: RuntimeHostMap | undefined,
  runtimeHost: RuntimeHostProjection
): RuntimeHostMap {
  return {
    ...(runtimeHosts ?? {}),
    [runtimeHost.runtimeHostId]: runtimeHost,
  }
}

/** Apply an Agent's hot Runtime Host projection. */
export function updateRuntimeHost(
  runtimeHosts: RuntimeHostMap | undefined,
  participants: Iterable<RuntimeHostParticipant>,
  participantId: string,
  runtimeHost: RuntimeHostProjection
): RuntimeHostUpdate {
  const participantList = Array.from(participants)
  const participant = participantList.find(
    (candidate) => candidate.id === participantId
  )
  const previousHostId = participant?.runtimeHostId
  const previousProjection = runtimeHosts?.[runtimeHost.runtimeHostId]

  return {
    runtimeHosts: registerRuntimeHost(runtimeHosts, runtimeHost),
    previousHostId,
    previousProjection,
  }
}

/** Return Agent ids currently referencing one shared Runtime Host. */
export function runtimeHostParticipantIds(
  participants: Iterable<RuntimeHostParticipant>,
  runtimeHostId: string,
  includeParticipantId?: string
): string[] {
  const ids = new Set(
    Array.from(participants)
      .filter(
        (participant) =>
          participant.kind === "agent" &&
          (participant.runtimeHostId === runtimeHostId ||
            participant.id === includeParticipantId)
      )
      .map((participant) => participant.id)
  )
  return [...ids]
}

/** Drop a host projection once its final participant reference is gone. */
export function garbageCollectRuntimeHosts(
  runtimeHosts: RuntimeHostMap | undefined,
  participants: Iterable<RuntimeHostParticipant>
): RuntimeHostMap | undefined {
  if (!runtimeHosts) return runtimeHosts
  const referenced = new Set(
    Array.from(participants)
      .map((participant) => participant.runtimeHostId)
      .filter((hostId): hostId is string => hostId !== undefined)
  )
  const next: RuntimeHostMap = {}
  for (const [hostId, projection] of Object.entries(runtimeHosts))
    if (referenced.has(hostId)) next[hostId] = projection
  return Object.keys(next).length === Object.keys(runtimeHosts).length
    ? runtimeHosts
    : next
}

/** Resolve the shared projection for an Agent, if its reference is valid. */
export function runtimeHostForParticipant(
  runtimeHosts: RuntimeHostMap | undefined,
  participant: Pick<RoomParticipant, "runtimeHostId">
): RuntimeHostProjection | undefined {
  return participant.runtimeHostId
    ? runtimeHosts?.[participant.runtimeHostId]
    : undefined
}
