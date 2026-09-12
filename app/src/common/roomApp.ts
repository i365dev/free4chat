import type { ParticipantKind } from "../room/types"

export const ROOM_APP_PROTOCOL_VERSION = 1 as const
export const ROOM_APP_MAX_PAYLOAD_BYTES = 16 * 1024
export const ROOM_APP_MAX_INSTANCES = 2
export const ROOM_APP_RELIABLE_MESSAGES_PER_SECOND = 20
export const ROOM_APP_REALTIME_MESSAGES_PER_SECOND = 60
export const ROOM_APP_BYTES_PER_SECOND = 256 * 1024
export const ROOM_APP_UNICAST_MESSAGES_PER_SECOND = 10
export const ROOM_APP_UNICAST_BYTES_PER_SECOND = 64 * 1024

export type RoomAppLane = "reliable" | "realtime"

export interface RoomAppDefinition {
  id: string
  label: string
  url: string
  origin: string
}

// This is the user-visible production catalog, not a user-controlled URL
// loader. The Worker-side flag keeps the catalog hidden until Room Apps are
// deliberately enabled in an environment.
export const ROOM_APP_CATALOG: readonly RoomAppDefinition[] = [
  {
    id: "whiteboard",
    label: "Whiteboard",
    url: "https://room-apps.free4.chat/whiteboard",
    origin: "https://room-apps.free4.chat",
  },
]

export const ROOM_APP_LOCAL_CATALOG: readonly RoomAppDefinition[] = [
  {
    id: "shared-canvas",
    label: "Shared Canvas",
    url: "http://localhost:8787/shared-canvas",
    origin: "http://localhost:8787",
  },
  {
    id: "tiny-arena",
    label: "Tiny Arena",
    url: "http://localhost:8787/tiny-arena",
    origin: "http://localhost:8787",
  },
]

export function experimentalRoomAppCatalog(): readonly RoomAppDefinition[] {
  return process.env.NODE_ENV === "development"
    ? ROOM_APP_LOCAL_CATALOG
    : ROOM_APP_CATALOG
}

export interface RoomAppParticipantProjection {
  participantId: string
  name: string
  kind: ParticipantKind
}

export interface RoomAppTransportEnvelope {
  protocolVersion: typeof ROOM_APP_PROTOCOL_VERSION
  appInstanceId: string
  lane: RoomAppLane
  sourceParticipantId: string
  payload: Record<string, unknown>
}

export interface RoomAppUnicastEnvelope {
  protocolVersion: typeof ROOM_APP_PROTOCOL_VERSION
  appInstanceId: string
  sourceParticipantId: string
  payload: Record<string, unknown>
}

export type RoomAppUnicastError =
  | "invalid_request"
  | "app_unavailable"
  | "invalid_target"
  | "target_unavailable"
  | "rate_limited"
  | "delivery_failed"

export interface RoomAppUnicastResult {
  requestId: string
  appInstanceId: string
  ok: boolean
  error?: RoomAppUnicastError
}

type RoomAppWireEnvelope = Omit<RoomAppTransportEnvelope, "sourceParticipantId">

export type RoomAppHostMessage =
  | {
      type: "ready"
      protocolVersion: typeof ROOM_APP_PROTOCOL_VERSION
      appInstanceId: string
      self: RoomAppParticipantProjection
      participants: RoomAppParticipantProjection[]
    }
  | {
      type: "participant_join" | "participant_leave"
      appInstanceId: string
      participant: RoomAppParticipantProjection
    }
  | {
      type: RoomAppLane
      appInstanceId: string
      sourceParticipantId: string
      payload: Record<string, unknown>
    }
  | {
      type: "unicast"
      appInstanceId: string
      sourceParticipantId: string
      payload: Record<string, unknown>
    }
  | ({ type: "unicast_result" } & RoomAppUnicastResult)
  | {
      type: "error"
      appInstanceId: string
      error:
        | "unsupported_message"
        | "rate_limited"
        | "payload_too_large"
        | "delivery_unavailable"
        | "too_many_pending"
    }

export type RoomAppClientMessage =
  | {
      type: "ready"
      appInstanceId: string
      handshakeToken: string
    }
  | {
      type: "sendReliable" | "sendRealtime"
      appInstanceId: string
      payload: Record<string, unknown>
    }
  | {
      type: "sendReliableTo"
      appInstanceId: string
      targetParticipantId: string
      payload: Record<string, unknown>
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function isValidRoomAppParticipantId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  )
}

export function isValidRoomAppRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function isValidRoomAppInstanceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9:-]{0,95}$/.test(value)
}

export function serializedRoomAppBytes(value: unknown): number | null {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value))
    return encoded.byteLength
  } catch {
    return null
  }
}

export function validateRoomAppPayload(
  value: unknown
):
  | { ok: true; payload: Record<string, unknown>; bytes: number }
  | { ok: false } {
  if (!isRecord(value) || "sourceParticipantId" in value) return { ok: false }
  const bytes = serializedRoomAppBytes(value)
  if (bytes === null || bytes > ROOM_APP_MAX_PAYLOAD_BYTES) return { ok: false }
  return { ok: true, payload: value, bytes }
}

export function encodeRoomAppEnvelope(
  envelope: Omit<RoomAppWireEnvelope, "protocolVersion">
): string | null {
  const payload = validateRoomAppPayload(envelope.payload)
  if (!payload.ok || !isValidRoomAppInstanceId(envelope.appInstanceId))
    return null
  const full: RoomAppWireEnvelope = {
    protocolVersion: ROOM_APP_PROTOCOL_VERSION,
    appInstanceId: envelope.appInstanceId,
    lane: envelope.lane,
    payload: payload.payload,
  }
  const bytes = serializedRoomAppBytes(full)
  if (bytes === null || bytes > ROOM_APP_MAX_PAYLOAD_BYTES) return null
  return JSON.stringify(full)
}

export function decodeRoomAppEnvelope(
  value: unknown
): RoomAppWireEnvelope | null {
  if (typeof value !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (
    parsed.protocolVersion !== ROOM_APP_PROTOCOL_VERSION ||
    typeof parsed.appInstanceId !== "string" ||
    !isValidRoomAppInstanceId(parsed.appInstanceId) ||
    (parsed.lane !== "reliable" && parsed.lane !== "realtime")
  )
    return null
  const payload = validateRoomAppPayload(parsed.payload)
  if (!payload.ok) return null
  return {
    protocolVersion: ROOM_APP_PROTOCOL_VERSION,
    appInstanceId: parsed.appInstanceId,
    lane: parsed.lane,
    payload: payload.payload,
  }
}

export function decodeRoomAppClientMessage(
  value: unknown,
  appInstanceId: string
): RoomAppClientMessage | null {
  if (!isRecord(value) || value.appInstanceId !== appInstanceId) return null
  if (
    value.type === "ready" &&
    typeof value.handshakeToken === "string" &&
    value.handshakeToken.length > 0 &&
    value.handshakeToken.length <= 128
  )
    return {
      type: "ready",
      appInstanceId,
      handshakeToken: value.handshakeToken,
    }
  if (value.type === "sendReliableTo") {
    if (!isValidRoomAppParticipantId(value.targetParticipantId)) return null
    const payload = validateRoomAppPayload(value.payload)
    if (!payload.ok) return null
    return {
      type: "sendReliableTo",
      appInstanceId,
      targetParticipantId: value.targetParticipantId,
      payload: payload.payload,
    }
  }
  if (value.type !== "sendReliable" && value.type !== "sendRealtime")
    return null
  const payload = validateRoomAppPayload(value.payload)
  if (!payload.ok) return null
  return {
    type: value.type,
    appInstanceId,
    payload: payload.payload,
  }
}

export function encodeRoomAppUnicastRequest(input: {
  requestId: string
  targetParticipantId: string
  appInstanceId: string
  payload: unknown
}): string | null {
  if (
    !isValidRoomAppRequestId(input.requestId) ||
    !isValidRoomAppParticipantId(input.targetParticipantId) ||
    !isValidRoomAppInstanceId(input.appInstanceId)
  )
    return null
  const payload = validateRoomAppPayload(input.payload)
  if (!payload.ok) return null
  const request = {
    type: "room-app-unicast",
    requestId: input.requestId,
    targetParticipantId: input.targetParticipantId,
    appInstanceId: input.appInstanceId,
    payload: payload.payload,
  }
  const bytes = serializedRoomAppBytes(request)
  if (bytes === null || bytes > ROOM_APP_MAX_PAYLOAD_BYTES) return null
  return JSON.stringify(request)
}

export function decodeRoomAppUnicastEnvelope(
  value: unknown,
  roomName: string
): RoomAppUnicastEnvelope | null {
  if (
    !isRecord(value) ||
    value.type !== "room-app-unicast" ||
    value.protocolVersion !== ROOM_APP_PROTOCOL_VERSION ||
    typeof value.appInstanceId !== "string" ||
    !isRoomAppInstanceForRoom(roomName, value.appInstanceId) ||
    !isValidRoomAppParticipantId(value.sourceParticipantId)
  )
    return null
  const payload = validateRoomAppPayload(value.payload)
  if (!payload.ok) return null
  const envelope = {
    protocolVersion: ROOM_APP_PROTOCOL_VERSION,
    appInstanceId: value.appInstanceId,
    sourceParticipantId: value.sourceParticipantId,
    payload: payload.payload,
  }
  const bytes = serializedRoomAppBytes(envelope)
  if (bytes === null || bytes > ROOM_APP_MAX_PAYLOAD_BYTES) return null
  return envelope
}

export function decodeRoomAppUnicastResult(
  value: unknown,
  roomName: string
): RoomAppUnicastResult | null {
  if (
    !isRecord(value) ||
    value.type !== "room-app-unicast-result" ||
    !isValidRoomAppRequestId(value.requestId) ||
    typeof value.appInstanceId !== "string" ||
    !isRoomAppInstanceForRoom(roomName, value.appInstanceId) ||
    typeof value.ok !== "boolean"
  )
    return null
  if (value.ok)
    return {
      requestId: value.requestId,
      appInstanceId: value.appInstanceId,
      ok: true,
    }
  const errors: readonly RoomAppUnicastError[] = [
    "invalid_request",
    "app_unavailable",
    "invalid_target",
    "target_unavailable",
    "rate_limited",
    "delivery_failed",
  ]
  if (!errors.includes(value.error as RoomAppUnicastError)) return null
  return {
    requestId: value.requestId,
    appInstanceId: value.appInstanceId,
    ok: false,
    error: value.error as RoomAppUnicastError,
  }
}

export function roomAppInstanceId(roomName: string, appId: string): string {
  let hash = 0x811c9dc5
  const input = `${roomName}:${appId}`
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${appId}:${hash.toString(16).padStart(8, "0")}`
}

export function isRoomAppInstanceForRoom(
  roomName: string,
  appInstanceId: string
): boolean {
  return experimentalRoomAppCatalog().some(
    (app) =>
      validateRoomAppDefinition(app) &&
      isRoomAppAllowlisted(app) &&
      roomAppInstanceId(roomName, app.id) === appInstanceId
  )
}

export function validateRoomAppDefinition(app: RoomAppDefinition): boolean {
  try {
    const url = new URL(app.url)
    return (
      /^[a-z0-9][a-z0-9-]{0,31}$/.test(app.id) &&
      app.label.length > 0 &&
      app.label.length <= 64 &&
      url.origin === app.origin &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "localhost"))
    )
  } catch {
    return false
  }
}

export function isRoomAppAllowlisted(app: RoomAppDefinition): boolean {
  return [ROOM_APP_CATALOG, ROOM_APP_LOCAL_CATALOG].some((catalog) =>
    catalog.some(
      (candidate) =>
        candidate.id === app.id &&
        candidate.url === app.url &&
        candidate.origin === app.origin &&
        validateRoomAppDefinition(candidate)
    )
  )
}

/** Resolve a URL query value only to an exact, validated production App id. */
export function resolveProductionRoomAppId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const app = ROOM_APP_CATALOG.find((candidate) => candidate.id === value)
  return app && validateRoomAppDefinition(app) && isRoomAppAllowlisted(app)
    ? app.id
    : null
}

export function projectRoomAppParticipants(
  participants: readonly RoomAppParticipantProjection[]
): RoomAppParticipantProjection[] {
  return participants
    .filter(
      (participant) =>
        typeof participant.participantId === "string" &&
        participant.participantId.length > 0 &&
        typeof participant.name === "string" &&
        (participant.kind === "human" || participant.kind === "agent")
    )
    .slice(0, 32)
    .map((participant) => ({
      participantId: participant.participantId,
      name: participant.name.slice(0, 64),
      kind: participant.kind,
    }))
}

export function roomAppRateGuard() {
  const events: Record<RoomAppLane, Array<{ at: number; bytes: number }>> = {
    reliable: [],
    realtime: [],
  }
  return {
    allow(lane: RoomAppLane, bytes: number, now = Date.now()): boolean {
      const windowStart = now - 1000
      for (const currentLane of ["reliable", "realtime"] as const)
        events[currentLane] = events[currentLane].filter(
          (sample) => sample.at > windowStart
        )
      const samples = events[lane]
      const countLimit =
        lane === "reliable"
          ? ROOM_APP_RELIABLE_MESSAGES_PER_SECOND
          : ROOM_APP_REALTIME_MESSAGES_PER_SECOND
      const totalBytes = Object.values(events)
        .flat()
        .reduce((sum, sample) => sum + sample.bytes, 0)
      if (
        samples.length >= countLimit ||
        totalBytes + bytes > ROOM_APP_BYTES_PER_SECOND
      )
        return false
      samples.push({ at: now, bytes })
      return true
    },
  }
}

export function roomAppUnicastRateGuard() {
  const events: Array<{ at: number; bytes: number }> = []
  return {
    allow(bytes: number, now = Date.now()): boolean {
      const windowStart = now - 1000
      while (events.length > 0 && events[0].at <= windowStart) events.shift()
      const totalBytes = events.reduce((sum, sample) => sum + sample.bytes, 0)
      if (
        events.length >= ROOM_APP_UNICAST_MESSAGES_PER_SECOND ||
        totalBytes + bytes > ROOM_APP_UNICAST_BYTES_PER_SECOND
      )
        return false
      events.push({ at: now, bytes })
      return true
    },
  }
}
