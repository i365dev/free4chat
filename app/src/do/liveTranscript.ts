import { isValidRuntimeHostId, type RuntimeHostMap } from "./runtimeHost"
import type {
  LiveTranscriptSegment,
  LiveTranscriptState,
  RoomParticipant,
  RuntimeHostProviderAssociation,
} from "../room/types"

export const NO_LIVE_TRANSCRIPT: LiveTranscriptState = { active: false }
export const MAX_LIVE_TRANSCRIPT_SEGMENTS = 500
// Legacy KV-backed Durable Objects limit an individual value to 128 KiB.
// Committed context lives in its own value, so use a conservative UTF-8
// serialized budget rather than an unsafe JavaScript character count.
export const MAX_LIVE_TRANSCRIPT_STORAGE_BYTES = 96 * 1024
// Compatibility export only; it is not the persistence safety boundary.
export const MAX_LIVE_TRANSCRIPT_TEXT_CHARS = 64 * 1024
export const MAX_LIVE_TRANSCRIPT_SEGMENT_TEXT_CHARS = 4_000
export const MAX_LIVE_TRANSCRIPT_SEGMENT_ID_LENGTH = 128

const SEGMENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const MAX_PARTICIPANT_ID_LENGTH = 256
const MAX_SPEAKER_LENGTH = 256

type TranscriptParticipant = Pick<
  RoomParticipant,
  "id" | "kind" | "name" | "connected" | "runtimeHostId"
>

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  )
}

export function isValidLiveTranscriptSegmentId(
  value: unknown
): value is string {
  return (
    isBoundedString(value, MAX_LIVE_TRANSCRIPT_SEGMENT_ID_LENGTH) &&
    SEGMENT_ID_PATTERN.test(value)
  )
}

function isLiveTranscriptState(value: unknown): value is LiveTranscriptState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<LiveTranscriptState>
  if (candidate.active === false) return true
  return (
    candidate.active === true &&
    isValidRuntimeHostId(candidate.producerRuntimeHostId) &&
    isBoundedString(
      candidate.startedByHumanParticipantId,
      MAX_PARTICIPANT_ID_LENGTH
    ) &&
    isSafePositiveInteger(candidate.epoch) &&
    isSafePositiveInteger(candidate.startedAt)
  )
}

function isLiveTranscriptSegment(
  value: unknown
): value is LiveTranscriptSegment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<LiveTranscriptSegment>
  return (
    isValidLiveTranscriptSegmentId(candidate.segmentId) &&
    isSafePositiveInteger(candidate.epoch) &&
    isSafePositiveInteger(candidate.sequence) &&
    isBoundedString(candidate.participantId, MAX_PARTICIPANT_ID_LENGTH) &&
    isBoundedString(candidate.speaker, MAX_SPEAKER_LENGTH) &&
    isBoundedString(candidate.text, MAX_LIVE_TRANSCRIPT_SEGMENT_TEXT_CHARS) &&
    isSafePositiveInteger(candidate.createdAt)
  )
}

function sameSegments(
  left: LiveTranscriptSegment[],
  right: LiveTranscriptSegment[]
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  )
}

export function liveTranscriptStorageByteLength({
  liveTranscript,
  liveTranscriptSegments,
  nextLiveTranscriptEpoch,
  nextTranscriptSequence,
}: {
  liveTranscript: LiveTranscriptState
  liveTranscriptSegments: LiveTranscriptSegment[]
  nextLiveTranscriptEpoch: number
  nextTranscriptSequence: number
}): number {
  return new TextEncoder().encode(
    JSON.stringify({
      liveTranscript,
      liveTranscriptSegments,
      nextLiveTranscriptEpoch,
      nextTranscriptSequence,
    })
  ).byteLength
}

export function boundLiveTranscriptSegments(
  segments: LiveTranscriptSegment[],
  liveTranscript: LiveTranscriptState = NO_LIVE_TRANSCRIPT,
  nextLiveTranscriptEpoch = 1,
  nextTranscriptSequence = 1
): LiveTranscriptSegment[] {
  const bounded = [...segments]
  while (
    bounded.length > MAX_LIVE_TRANSCRIPT_SEGMENTS ||
    liveTranscriptStorageByteLength({
      liveTranscript,
      liveTranscriptSegments: bounded,
      nextLiveTranscriptEpoch,
      nextTranscriptSequence,
    }) > MAX_LIVE_TRANSCRIPT_STORAGE_BYTES
  ) {
    if (!bounded.shift()) break
  }
  return bounded
}

// Stored Rooms predate Live Transcript. Repair malformed data into a safe,
// bounded shape before RoomSession evaluates its current authorization.
export function normalizeStoredLiveTranscript({
  liveTranscript,
  liveTranscriptSegments,
  nextLiveTranscriptEpoch,
  nextTranscriptSequence,
}: {
  liveTranscript: unknown
  liveTranscriptSegments: unknown
  nextLiveTranscriptEpoch: unknown
  nextTranscriptSequence: unknown
}): {
  liveTranscript: LiveTranscriptState
  liveTranscriptSegments: LiveTranscriptSegment[]
  nextLiveTranscriptEpoch: number
  nextTranscriptSequence: number
  changed: boolean
} {
  const state = isLiveTranscriptState(liveTranscript)
    ? liveTranscript
    : NO_LIVE_TRANSCRIPT
  let changed = state !== liveTranscript

  const rawSegments = Array.isArray(liveTranscriptSegments)
    ? liveTranscriptSegments
    : []
  if (!Array.isArray(liveTranscriptSegments)) changed = true
  const sorted = rawSegments
    .filter(isLiveTranscriptSegment)
    .sort((left, right) => left.sequence - right.sequence)
  if (sorted.length !== rawSegments.length) changed = true

  const seenSegments = new Set<string>()
  const seenSequences = new Set<number>()
  const deduplicated = sorted.filter((segment) => {
    const key = `${segment.epoch}:${segment.segmentId}`
    if (seenSegments.has(key) || seenSequences.has(segment.sequence)) {
      changed = true
      return false
    }
    seenSegments.add(key)
    seenSequences.add(segment.sequence)
    return true
  })
  const maxEpoch = state.active ? state.epoch : 0
  const maxSequence = deduplicated.at(-1)?.sequence ?? 0
  const normalizedNextEpoch = isSafePositiveInteger(nextLiveTranscriptEpoch)
    ? Math.max(nextLiveTranscriptEpoch, maxEpoch + 1)
    : Math.max(1, maxEpoch + 1)
  const normalizedNextSequence = isSafePositiveInteger(nextTranscriptSequence)
    ? Math.max(nextTranscriptSequence, maxSequence + 1)
    : Math.max(1, maxSequence + 1)
  if (nextLiveTranscriptEpoch !== normalizedNextEpoch) changed = true
  if (nextTranscriptSequence !== normalizedNextSequence) changed = true
  const bounded = boundLiveTranscriptSegments(
    deduplicated,
    state,
    normalizedNextEpoch,
    normalizedNextSequence
  )
  if (!sameSegments(bounded, rawSegments as LiveTranscriptSegment[]))
    changed = true

  return {
    liveTranscript: state,
    liveTranscriptSegments: bounded,
    nextLiveTranscriptEpoch: normalizedNextEpoch,
    nextTranscriptSequence: normalizedNextSequence,
    changed,
  }
}

function verifiedMembersForHost({
  providers,
  participants,
  runtimeHostId,
}: {
  providers: Record<string, RuntimeHostProviderAssociation> | undefined
  participants: Iterable<TranscriptParticipant>
  runtimeHostId: string
}): string[] {
  const association = providers?.[runtimeHostId]
  if (!association) return []
  const byId = new Map(
    Array.from(participants).map((participant) => [participant.id, participant])
  )
  return association.verifiedParticipantIds.filter((participantId) => {
    const participant = byId.get(participantId)
    return (
      participant?.kind === "agent" &&
      participant.runtimeHostId === runtimeHostId
    )
  })
}

// Unlike Start, a running transcript deliberately tolerates the selected
// Human's transient WebSocket disconnect. True leave/expiry removes either
// that Human or the private provider association, and this then fails closed.
export function isLiveTranscriptProducerValid({
  liveTranscript,
  participants,
  runtimeHosts,
  providers,
  mediaAvailable,
}: {
  liveTranscript: LiveTranscriptState
  participants: Iterable<TranscriptParticipant>
  runtimeHosts: RuntimeHostMap | undefined
  providers: Record<string, RuntimeHostProviderAssociation> | undefined
  mediaAvailable?: boolean
}): boolean {
  if (!liveTranscript.active) return true
  if (mediaAvailable === false) return false
  const participantList = Array.from(participants)
  const hostId = liveTranscript.producerRuntimeHostId
  const association = providers?.[hostId]
  const startedBy = participantList.find(
    (participant) =>
      participant.id === liveTranscript.startedByHumanParticipantId
  )
  return (
    runtimeHosts?.[hostId]?.speech.stt === true &&
    startedBy?.kind === "human" &&
    association?.humanParticipantId === startedBy.id &&
    verifiedMembersForHost({
      providers,
      participants: participantList,
      runtimeHostId: hostId,
    }).length > 0
  )
}

export function normalizeLiveTranscriptProducer(args: {
  liveTranscript: LiveTranscriptState
  participants: Iterable<TranscriptParticipant>
  runtimeHosts: RuntimeHostMap | undefined
  providers: Record<string, RuntimeHostProviderAssociation> | undefined
  mediaAvailable?: boolean
}): { liveTranscript: LiveTranscriptState; changed: boolean } {
  if (isLiveTranscriptProducerValid(args))
    return { liveTranscript: args.liveTranscript, changed: false }
  return { liveTranscript: NO_LIVE_TRANSCRIPT, changed: true }
}

export function startLiveTranscript({
  liveTranscript,
  nextLiveTranscriptEpoch,
  humanParticipantId,
  runtimeHostId,
  now,
}: {
  liveTranscript: LiveTranscriptState
  nextLiveTranscriptEpoch: number
  humanParticipantId: string
  runtimeHostId: string
  now: number
}): {
  liveTranscript: LiveTranscriptState
  nextLiveTranscriptEpoch: number
  idempotent: boolean
} {
  if (liveTranscript.active)
    return { liveTranscript, nextLiveTranscriptEpoch, idempotent: true }
  const epoch = nextLiveTranscriptEpoch
  return {
    liveTranscript: {
      active: true,
      producerRuntimeHostId: runtimeHostId,
      startedByHumanParticipantId: humanParticipantId,
      epoch,
      startedAt: now,
    },
    nextLiveTranscriptEpoch: epoch + 1,
    idempotent: false,
  }
}

export function stopLiveTranscript(
  liveTranscript: LiveTranscriptState
): LiveTranscriptState {
  return liveTranscript.active ? NO_LIVE_TRANSCRIPT : liveTranscript
}

export function canAgentAppendLiveTranscript({
  liveTranscript,
  caller,
  participants,
  runtimeHosts,
  providers,
  mediaAvailable,
}: {
  liveTranscript: LiveTranscriptState
  caller: Pick<TranscriptParticipant, "id" | "kind" | "runtimeHostId">
  participants: Iterable<TranscriptParticipant>
  runtimeHosts: RuntimeHostMap | undefined
  providers: Record<string, RuntimeHostProviderAssociation> | undefined
  mediaAvailable?: boolean
}): boolean {
  if (!liveTranscript.active || caller.kind !== "agent") return false
  const hostId = liveTranscript.producerRuntimeHostId
  return (
    caller.runtimeHostId === hostId &&
    isLiveTranscriptProducerValid({
      liveTranscript,
      participants,
      runtimeHosts,
      providers,
      mediaAvailable,
    }) &&
    verifiedMembersForHost({
      providers,
      participants,
      runtimeHostId: hostId,
    }).includes(caller.id)
  )
}

export function appendLiveTranscriptSegment({
  liveTranscript,
  liveTranscriptSegments,
  nextTranscriptSequence,
  epoch,
  segmentId,
  sourceParticipant,
  text,
  now,
}: {
  liveTranscript: LiveTranscriptState
  liveTranscriptSegments: LiveTranscriptSegment[]
  nextTranscriptSequence: number
  epoch: unknown
  segmentId: unknown
  sourceParticipant: Pick<RoomParticipant, "id" | "kind" | "name"> | undefined
  text: unknown
  now: number
}):
  | {
      ok: true
      duplicate: boolean
      liveTranscriptSegments: LiveTranscriptSegment[]
      nextTranscriptSequence: number
      segment?: LiveTranscriptSegment
    }
  | { ok: false; error: string } {
  if (!liveTranscript.active)
    return { ok: false, error: "live_transcript_inactive" }
  if (epoch !== liveTranscript.epoch)
    return { ok: false, error: "live_transcript_epoch_mismatch" }
  if (!isValidLiveTranscriptSegmentId(segmentId))
    return { ok: false, error: "invalid_live_transcript_segment_id" }

  if (
    liveTranscriptSegments.some(
      (segment) => segment.epoch === epoch && segment.segmentId === segmentId
    )
  )
    return {
      ok: true,
      duplicate: true,
      liveTranscriptSegments,
      nextTranscriptSequence,
    }

  if (
    !sourceParticipant ||
    sourceParticipant.kind !== "human" ||
    !isBoundedString(sourceParticipant.id, MAX_PARTICIPANT_ID_LENGTH) ||
    !isBoundedString(sourceParticipant.name, MAX_SPEAKER_LENGTH)
  )
    return { ok: false, error: "invalid_live_transcript_source" }
  if (typeof text !== "string")
    return { ok: false, error: "invalid_live_transcript_text" }
  const normalizedText = text.trim()
  if (
    normalizedText.length === 0 ||
    normalizedText.length > MAX_LIVE_TRANSCRIPT_SEGMENT_TEXT_CHARS
  )
    return { ok: false, error: "invalid_live_transcript_text" }

  const segment: LiveTranscriptSegment = {
    segmentId,
    epoch,
    sequence: nextTranscriptSequence,
    participantId: sourceParticipant.id,
    speaker: sourceParticipant.name,
    text: normalizedText,
    createdAt: now,
  }
  return {
    ok: true,
    duplicate: false,
    liveTranscriptSegments: boundLiveTranscriptSegments(
      [...liveTranscriptSegments, segment],
      liveTranscript,
      // Bound against the exact counter values persisted with this new
      // segment, before RoomSession mutates the Durable Object state.
      liveTranscript.epoch + 1,
      nextTranscriptSequence + 1
    ),
    nextTranscriptSequence: nextTranscriptSequence + 1,
    segment,
  }
}

export type { TranscriptParticipant }
