import type {
  AgentCapabilities,
  CollabEvent,
  CollabEventKind,
  RoomParticipant,
} from "../room/types"

// #106 Phase A/B bounds. Deliberately small: capability advertisement and
// collaboration envelopes are discovery/transport metadata, not a task
// database. Everything here is pure so the DO stays thin and the rules stay
// deterministically testable (same pattern as do/meetingNotesAuth.ts).

export const MAX_ADVERTISED_CAPABILITIES = 8
export const MAX_CAPABILITY_LENGTH = 48
export const COLLAB_ACTION_TYPE = "collab"
export const MAX_COLLAB_SUMMARY_LENGTH = 1200
export const MAX_COLLAB_DETAILS_ENTRIES = 16
export const MAX_COLLAB_DETAIL_KEY_LENGTH = 64
export const MAX_COLLAB_DETAIL_VALUE_LENGTH = 512
export const MAX_COLLAB_ATTACHMENT_REFS = 3
export const MAX_REQUEST_ID_LENGTH = 64

// Lowercase dot/dash/underscore namespaced tokens: "code.edit",
// "browser.authenticated", "shell", "filesystem.local". A single segment is
// fine; empty or separator-led segments are not.
const CAPABILITY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

// Opaque caller-chosen correlation token. Boring and permissive on purpose —
// UUIDs are the documented convention, not a wire requirement.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{3,63})$/

export type CapabilityValidationResult =
  | { ok: true; capabilities: string[] }
  | { ok: false; error: "invalid_capabilities"; reason: string }

/** Validates an advertised-capability list exactly as submitted over the
 * wire. Invalid input is rejected (never silently repaired) so an Agent
 * advertising garbage fails loudly instead of shipping a wrong self-image. */
export function validateAdvertisedCapabilities(
  input: unknown
): CapabilityValidationResult {
  if (!Array.isArray(input))
    return { ok: false, error: "invalid_capabilities", reason: "must_be_array" }
  if (input.length > MAX_ADVERTISED_CAPABILITIES)
    return {
      ok: false,
      error: "invalid_capabilities",
      reason: `too_many_max_${MAX_ADVERTISED_CAPABILITIES}`,
    }
  const capabilities: string[] = []
  for (const raw of input) {
    if (typeof raw !== "string")
      return {
        ok: false,
        error: "invalid_capabilities",
        reason: "entries_must_be_strings",
      }
    const token = raw.trim().toLowerCase()
    if (token.length === 0 || token.length > MAX_CAPABILITY_LENGTH)
      return {
        ok: false,
        error: "invalid_capabilities",
        reason: `entry_length_1_${MAX_CAPABILITY_LENGTH}`,
      }
    if (!CAPABILITY_PATTERN.test(token))
      return {
        ok: false,
        error: "invalid_capabilities",
        reason: "entry_must_be_namespaced_token",
      }
    if (!capabilities.includes(token)) capabilities.push(token)
  }
  return { ok: true, capabilities }
}

/** Builds the stored AgentCapabilities for a joining/updating agent. An empty
 * validated list simply omits `advertised` — text-only agents keep the exact
 * historical shape `{ text: true }`. */
export function agentCapabilitiesFrom(validated: string[]): AgentCapabilities {
  return validated.length > 0
    ? { text: true, advertised: validated }
    : { text: true }
}

/** Storage-hygiene pass for already-persisted participant records: unlike
 * ingestion, invalid entries are dropped rather than rejected — a bad record
 * must never wedge room loading. Returns the same reference when clean. */
export function sanitizeStoredAgentCapabilities(
  capabilities: AgentCapabilities | undefined
): { capabilities: AgentCapabilities; changed: boolean } {
  if (!capabilities || capabilities.text !== true)
    return { capabilities: { text: true }, changed: true }
  if (capabilities.advertised === undefined)
    return { capabilities, changed: false }
  const cleaned = capabilities.advertised.filter(
    (token) =>
      typeof token === "string" &&
      token.length > 0 &&
      token.length <= MAX_CAPABILITY_LENGTH &&
      CAPABILITY_PATTERN.test(token)
  )
  const deduped = [...new Set(cleaned)].slice(0, MAX_ADVERTISED_CAPABILITIES)
  if (
    deduped.length === capabilities.advertised.length &&
    deduped.every((token, index) => token === capabilities.advertised[index])
  )
    return { capabilities, changed: false }
  return {
    capabilities: agentCapabilitiesFrom(deduped),
    changed: true,
  }
}

export interface ParticipantRosterEntry {
  id: string
  name: string
  kind: RoomParticipant["kind"]
  advertised?: string[]
}

/** Compact connected-participant/capability projection for Harness context.
 * Answers "who here can potentially do X" without dumping full room state:
 * no tokens, no media session identifiers, no history. */
export function rosterProjection(
  participants: Record<string, RoomParticipant>
): ParticipantRosterEntry[] {
  return Object.values(participants)
    .filter((participant) => participant.connected)
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      kind: participant.kind,
      ...(participant.kind === "agent" && participant.capabilities?.advertised
        ? { advertised: participant.capabilities.advertised }
        : {}),
    }))
}

export interface CollabEventInput {
  kind?: unknown
  requestId?: unknown
  targetParticipantId?: unknown
  summary?: unknown
  details?: unknown
  attachmentIds?: unknown
}

export interface CollabValidationContext {
  senderParticipantId: string
  participants: Record<string, RoomParticipant>
  attachments: Array<Pick<{ id: string }, "id">>
}

type CollabValidationResult =
  | { ok: true; event: CollabEvent }
  | { ok: false; error: string }

function validateCollabDetails(input: unknown): {
  ok: boolean
  error?: string
  details?: Record<string, string>
} {
  if (input === undefined) return { ok: true }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "invalid_details" }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length > MAX_COLLAB_DETAILS_ENTRIES)
    return { ok: false, error: "too_many_details" }
  const details: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_COLLAB_DETAIL_KEY_LENGTH ||
      typeof value !== "string" ||
      value.length > MAX_COLLAB_DETAIL_VALUE_LENGTH
    )
      return { ok: false, error: "invalid_detail_entry" }
    details[key] = value
  }
  return { ok: true, details }
}

function validateCollabAttachmentRefs(
  input: unknown,
  context: CollabValidationContext
): { ok: boolean; error?: string; ids?: string[] } {
  if (input === undefined) return { ok: true }
  if (!Array.isArray(input) || input.some((id) => typeof id !== "string"))
    return { ok: false, error: "invalid_attachment_refs" }
  const unique = [...new Set(input as string[])]
  if (unique.length > MAX_COLLAB_ATTACHMENT_REFS)
    return { ok: false, error: "too_many_attachment_refs" }
  for (const id of unique)
    if (!context.attachments.some((attachment) => attachment.id === id))
      return { ok: false, error: "unknown_attachment" }
  return { ok: true, ids: unique }
}

function boundedSummary(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, MAX_COLLAB_SUMMARY_LENGTH)
}

const COLLAB_KINDS: CollabEventKind[] = [
  "request",
  "accepted",
  "declined",
  "completed",
  "failed",
]

/** Validates one collaboration envelope against current room state. The
 * request kind requires a live target participant; response/result kinds are
 * shape-checked here while correlation (requestId known, responder is the
 * request's target) is enforced by CollabRegistry in the DO. A request may
 * omit requestId — one is generated (injectable for deterministic tests) so
 * the plain "send a request" path works without manual bookkeeping.
 * Free4Chat only transports these envelopes — it never decides their
 * content. */
export function validateCollabEvent(
  input: CollabEventInput,
  context: CollabValidationContext,
  options?: { generateRequestId?: () => string }
): CollabValidationResult {
  const kind = input.kind
  if (
    typeof kind !== "string" ||
    !COLLAB_KINDS.includes(kind as CollabEventKind)
  )
    return { ok: false, error: "invalid_collab_kind" }
  const collabKind = kind as CollabEventKind

  let requestId =
    typeof input.requestId === "string" ? input.requestId.trim() : ""
  if (!requestId && collabKind === "request")
    requestId = (options?.generateRequestId ?? (() => crypto.randomUUID()))()
  if (!REQUEST_ID_PATTERN.test(requestId))
    return { ok: false, error: "invalid_request_id" }

  const targetParticipantId =
    typeof input.targetParticipantId === "string"
      ? input.targetParticipantId.trim()
      : ""
  const target = context.participants[targetParticipantId] ?? null

  if (kind === "request") {
    if (!target || !target.connected)
      return { ok: false, error: "target_not_in_room" }
    if (targetParticipantId === context.senderParticipantId)
      return { ok: false, error: "self_request" }
    const summary = boundedSummary(input.summary)
    if (!summary) return { ok: false, error: "summary_required" }
    const details = validateCollabDetails(input.details)
    if (!details.ok) return { ok: false, error: details.error! }
    const refs = validateCollabAttachmentRefs(input.attachmentIds, context)
    if (!refs.ok) return { ok: false, error: refs.error! }
    return {
      ok: true,
      event: {
        requestId,
        kind: collabKind,
        fromParticipantId: context.senderParticipantId,
        targetParticipantId,
        summary,
        ...(details.details ? { details: details.details } : {}),
        ...(refs.ids ? { attachmentIds: refs.ids } : {}),
      },
    }
  }

  // Responses/results travel toward the original requester; the DO reuses
  // this same envelope with from/target derived from the tracked request, so
  // callers submit correlation + payload only.
  if (targetParticipantId && (!target || !target.connected))
    return { ok: false, error: "target_not_in_room" }
  const summary = boundedSummary(input.summary)
  const details = validateCollabDetails(input.details)
  if (!details.ok) return { ok: false, error: details.error! }
  const refs = validateCollabAttachmentRefs(input.attachmentIds, context)
  if (!refs.ok) return { ok: false, error: refs.error! }
  return {
    ok: true,
    event: {
      requestId,
      kind: collabKind,
      fromParticipantId: "",
      targetParticipantId: "",
      ...(summary ? { summary } : {}),
      ...(details.details ? { details: details.details } : {}),
      ...(refs.ids ? { attachmentIds: refs.ids } : {}),
    },
  }
}

export interface CollabRequestRecord {
  requestId: string
  fromParticipantId: string
  targetParticipantId: string
  sequenceByKind: Partial<Record<CollabEventKind, number>>
}

export type CollabRegistryOutcome =
  | { action: "recorded"; sequence: number }
  | { action: "duplicate"; sequence: number }
  | { action: "rejected"; error: "unknown_request" | "not_request_target" }

/** Bounded, room-lifetime bookkeeping for collaboration requests. Lives in DO
 * memory only — deliberately NOT persisted task storage (#106): losing it on
 * a DO restart merely re-opens duplicate-retry protection, it never loses
 * conversation data, which lives in the message log itself. Doubles as the
 * delivery-dedup boundary: the monotonic room sequence + Runtime cursor
 * handle redelivery; this registry handles retried *sends*. */
export class CollabRegistry {
  private readonly requests = new Map<string, CollabRequestRecord>()

  constructor(private readonly maxRequests: number = 128) {}

  get size(): number {
    return this.requests.size
  }

  find(requestId: string): CollabRequestRecord | undefined {
    return this.requests.get(requestId)
  }

  /** Drops all tracking — used when a DO instance's room is recreated after
   * expiry so stale requestIds from a previous room generation can never
   * suppress or redirect new ones. */
  clear(): void {
    this.requests.clear()
  }

  /** Records a new request. A repeated requestId (network retry after the
   * first append succeeded) collapses to the original sequence instead of
   * appending a second, double-execution-inducing event. */
  recordRequest(event: CollabEvent, sequence: number): CollabRegistryOutcome {
    const existing = this.requests.get(event.requestId)
    if (existing)
      return {
        action: "duplicate",
        sequence: existing.sequenceByKind.request ?? sequence,
      }
    this.evictWhileFull()
    this.requests.set(event.requestId, {
      requestId: event.requestId,
      fromParticipantId: event.fromParticipantId,
      targetParticipantId: event.targetParticipantId,
      sequenceByKind: { request: sequence },
    })
    return { action: "recorded", sequence }
  }

  /** Decides a response/result BEFORE anything is appended so retried
   * identical lifecycle steps short-circuit idempotently instead of waking
   * the peer twice. Pure lookup — mutates nothing. */
  precheckResponse(
    requestId: string,
    kind: CollabEventKind,
    responderParticipantId: string
  ):
    | { action: "record" }
    | { action: "duplicate"; sequence: number }
    | {
        action: "rejected"
        error: "unknown_request" | "not_request_target"
      } {
    const record = this.requests.get(requestId)
    if (!record) return { action: "rejected", error: "unknown_request" }
    if (responderParticipantId !== record.targetParticipantId)
      return { action: "rejected", error: "not_request_target" }
    const existing = record.sequenceByKind[kind]
    if (existing !== undefined)
      return { action: "duplicate", sequence: existing }
    return { action: "record" }
  }

  /** Commits the sequence of an already-prechecked response/result. */
  commitResponse(
    requestId: string,
    kind: CollabEventKind,
    sequence: number
  ): void {
    const record = this.requests.get(requestId)
    if (!record) return
    record.sequenceByKind[kind] = sequence
  }

  /** Combined check+commit for replay paths that already trust the durable
   * log (rebuild). */
  recordResponse(
    event: CollabEvent,
    responderParticipantId: string,
    sequence: number
  ): CollabRegistryOutcome {
    const precheck = this.precheckResponse(
      event.requestId,
      event.kind,
      responderParticipantId
    )
    if (precheck.action === "rejected")
      return { action: "rejected", error: precheck.error }
    if (precheck.action === "duplicate")
      return { action: "duplicate", sequence: precheck.sequence }
    this.commitResponse(event.requestId, event.kind, sequence)
    return { action: "recorded", sequence }
  }

  /** Rebuilds correlation state from the bounded durable message log after a
   * Durable Object eviction/restart (#106 review fix): room.messages is the
   * source of truth; this only restores the in-memory routing/dedup indexes.
   * The newest requests win when the log holds more than the registry bound;
   * entries older than that horizon lose their bookkeeping, which degrades
   * to rejecting very late responses as unknown — never to double-execution.
   * */
  rebuild(
    entries: ReadonlyArray<{ event: CollabEvent; sequence: number }>
  ): void {
    const grouped = new Map<
      string,
      Array<{ event: CollabEvent; sequence: number }>
    >()
    for (const entry of entries) {
      const event = entry?.event
      if (!event || typeof event.requestId !== "string" || !event.kind) continue
      const log = grouped.get(event.requestId) ?? []
      log.push({ event, sequence: entry.sequence })
      grouped.set(event.requestId, log)
    }
    for (const requestId of [...grouped.keys()].slice(-this.maxRequests)) {
      const log = grouped.get(requestId)!
      // Fail closed (#106 final review): correlation identity comes ONLY
      // from a retained kind:"request" event. If the bounded log has evicted
      // the original request while keeping later responses, rebuilding from
      // those responses would invert from/target routing — the requestId is
      // omitted entirely and late responses degrade to unknown_request.
      const requestEntry = log.find((entry) => entry.event.kind === "request")
      if (!requestEntry) continue
      this.requests.set(requestId, {
        requestId,
        fromParticipantId: requestEntry.event.fromParticipantId,
        targetParticipantId: requestEntry.event.targetParticipantId,
        sequenceByKind: {},
      })
      for (const { event, sequence } of log)
        if (event.kind === "request")
          this.requests.get(requestId)!.sequenceByKind.request ??= sequence
        else this.recordResponse(event, event.fromParticipantId, sequence)
    }
  }

  /** Fills from/target for a response/result envelope from the tracked
   * request, so responders never self-report routing. */
  routingFor(
    requestId: string,
    responderParticipantId: string
  ): { fromParticipantId: string; targetParticipantId: string } | null {
    const record = this.requests.get(requestId)
    if (!record || responderParticipantId !== record.targetParticipantId)
      return null
    return {
      fromParticipantId: responderParticipantId,
      targetParticipantId: record.fromParticipantId,
    }
  }

  private evictWhileFull(): void {
    while (this.requests.size >= this.maxRequests) {
      const oldest = this.requests.keys().next()
      if (oldest.done) break
      this.requests.delete(oldest.value)
    }
  }
}
