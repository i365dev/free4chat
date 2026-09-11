import type { ParticipantKind } from "../room/types"

export const ROOM_APP_PROTOCOL_VERSION = 1 as const
export const ROOM_APP_MAX_PAYLOAD_BYTES = 16 * 1024
export const ROOM_APP_MAX_INSTANCES = 2
export const ROOM_APP_RELIABLE_MESSAGES_PER_SECOND = 20
export const ROOM_APP_REALTIME_MESSAGES_PER_SECOND = 60
export const ROOM_APP_BYTES_PER_SECOND = 256 * 1024

export type RoomAppLane = "reliable" | "realtime"

export interface RoomAppDefinition {
  id: string
  label: string
  url: string
  origin: string
}

// These are build-time curated fixture identities, not a user-controlled URL
// loader. The Worker-side flag keeps the catalog hidden until the experiment is
// deliberately enabled in an environment. Both fixtures share this origin
// contract and may later be deployed under these paths without changing the
// host/bridge protocol.
export const ROOM_APP_CATALOG: readonly RoomAppDefinition[] = [
  {
    id: "shared-canvas",
    label: "Shared Canvas",
    url: "https://room-apps.free4.chat/shared-canvas",
    origin: "https://room-apps.free4.chat",
  },
  {
    id: "tiny-arena",
    label: "Tiny Arena",
    url: "https://room-apps.free4.chat/tiny-arena",
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
  payload: Record<string, unknown>
}

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
      payload: Record<string, unknown>
    }
  | {
      type: "error"
      appInstanceId: string
      error: "unsupported_message" | "rate_limited" | "payload_too_large"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
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
  if (!isRecord(value)) return { ok: false }
  const bytes = serializedRoomAppBytes(value)
  if (bytes === null || bytes > ROOM_APP_MAX_PAYLOAD_BYTES) return { ok: false }
  return { ok: true, payload: value, bytes }
}

export function encodeRoomAppEnvelope(
  envelope: Omit<RoomAppTransportEnvelope, "protocolVersion">
): string | null {
  const payload = validateRoomAppPayload(envelope.payload)
  if (!payload.ok || !/^[a-z0-9][a-z0-9:-]{0,95}$/.test(envelope.appInstanceId))
    return null
  const full: RoomAppTransportEnvelope = {
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
): RoomAppTransportEnvelope | null {
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
    !/^[a-z0-9][a-z0-9:-]{0,95}$/.test(parsed.appInstanceId) ||
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

export function roomAppInstanceId(roomName: string, appId: string): string {
  let hash = 0x811c9dc5
  const input = `${roomName}:${appId}`
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${appId}:${hash.toString(16).padStart(8, "0")}`
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
      const samples = events[lane].filter((sample) => sample.at > windowStart)
      events[lane] = samples
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
