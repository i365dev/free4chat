import type { ParticipantKind } from "../room/types"

export const ROOM_APP_PROTOCOL_VERSION = 1 as const
export const ROOM_APP_MAX_PAYLOAD_BYTES = 16 * 1024
export const ROOM_APP_MAX_INSTANCES = 2
export const ROOM_APP_RELIABLE_MESSAGES_PER_SECOND = 20
export const ROOM_APP_REALTIME_MESSAGES_PER_SECOND = 60
export const ROOM_APP_BYTES_PER_SECOND = 256 * 1024
export const ROOM_APP_UNICAST_MESSAGES_PER_SECOND = 10
export const ROOM_APP_UNICAST_BYTES_PER_SECOND = 64 * 1024
export const ROOM_APP_TRUSTED_ORIGIN = "https://room-apps.free4.chat"
export const ROOM_APP_CATALOG_ENDPOINT = `${ROOM_APP_TRUSTED_ORIGIN}/_catalog.json`
export const ROOM_APP_CATALOG_MAX_ENTRIES = 32
export const ROOM_APP_CATALOG_MAX_BYTES = 16 * 1024
export const ROOM_APP_CATALOG_TIMEOUT_MS = 5_000
export const ROOM_APP_CATALOG_REFRESH_INTERVAL_MS = 60_000
const BROWSER_ROOM_APP_CATALOG_CACHE_TTL_MS =
  ROOM_APP_CATALOG_REFRESH_INTERVAL_MS - 1_000

export type RoomAppLane = "reliable" | "realtime"

export interface RoomAppDefinition {
  id: string
  label: string
  url: string
  origin: string
  source?: "official" | "generated"
  srcDoc?: string
}

/** Public, read-only Worker Service Binding used by the Room authority. */
export interface RoomAppCatalogService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

// Core has no App portfolio fallback. The Lab-owned catalog is authoritative;
// an unavailable or invalid first response therefore fails closed.
export const EMPTY_ROOM_APP_CATALOG: readonly RoomAppDefinition[] = []

let currentProductionRoomAppCatalog: readonly RoomAppDefinition[] =
  EMPTY_ROOM_APP_CATALOG

export function currentRoomAppCatalog(): readonly RoomAppDefinition[] {
  return currentProductionRoomAppCatalog
}

/** Install a catalog already returned by the bounded remote-catalog loader. */
export function setProductionRoomAppCatalog(
  catalog: readonly RoomAppDefinition[]
): void {
  if (catalog.length > ROOM_APP_CATALOG_MAX_ENTRIES) return
  const safeCatalog = parseRoomAppCatalog({
    version: 1,
    apps: catalog.map((app) => {
      let path = ""
      try {
        const url = new URL(app.url)
        if (
          app.origin === ROOM_APP_TRUSTED_ORIGIN &&
          url.origin === ROOM_APP_TRUSTED_ORIGIN &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        )
          path = url.pathname
      } catch {
        // An invalid URL becomes an invalid path and fails catalog parsing.
      }
      return { id: app.id, label: app.label, path, status: "active" }
    }),
  })
  if (safeCatalog) currentProductionRoomAppCatalog = safeCatalog
}

export function isValidRoomAppId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

/**
 * Parse Lab's public runtime catalog. The catalog can select paths only below
 * the fixed trusted origin; disabled entries are valid metadata but never
 * returned as launchable definitions.
 */
export function parseRoomAppCatalog(
  value: unknown
): RoomAppDefinition[] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "apps"]) ||
    value.version !== 1 ||
    !Array.isArray(value.apps) ||
    value.apps.length > ROOM_APP_CATALOG_MAX_ENTRIES
  )
    return null

  const seen = new Set<string>()
  const active: RoomAppDefinition[] = []
  for (const rawApp of value.apps) {
    if (
      !isRecord(rawApp) ||
      !hasExactKeys(rawApp, ["id", "label", "path", "status"]) ||
      !isValidRoomAppId(rawApp.id) ||
      seen.has(rawApp.id) ||
      typeof rawApp.label !== "string" ||
      rawApp.label.trim().length === 0 ||
      rawApp.label.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(rawApp.label) ||
      rawApp.path !== `/${rawApp.id}` ||
      (rawApp.status !== "active" && rawApp.status !== "disabled")
    )
      return null

    seen.add(rawApp.id)
    if (rawApp.status === "active") {
      active.push({
        id: rawApp.id,
        label: rawApp.label,
        url: `${ROOM_APP_TRUSTED_ORIGIN}${rawApp.path}`,
        origin: ROOM_APP_TRUSTED_ORIGIN,
      })
    }
  }
  return active
}

async function readBoundedCatalogBody(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally {
    reader.releaseLock()
  }
}

/** Create a coalescing loader for the fixed, trusted Lab endpoint. */
export function createRoomAppCatalogLoader(
  fetchCatalog: typeof fetch,
  cacheTtlMs = 60_000,
  now: () => number = () => Date.now()
): () => Promise<readonly RoomAppDefinition[]> {
  let result: readonly RoomAppDefinition[] | null = null
  let hasAcceptedRemoteCatalog = false
  let expiresAt = 0
  let pending: Promise<readonly RoomAppDefinition[]> | null = null
  return () => {
    if (result && now() < expiresAt) return Promise.resolve(result)
    if (pending) return pending
    pending = (async () => {
      const fallback = () =>
        hasAcceptedRemoteCatalog && result ? result : EMPTY_ROOM_APP_CATALOG
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        ROOM_APP_CATALOG_TIMEOUT_MS
      )
      try {
        const response = await fetchCatalog(ROOM_APP_CATALOG_ENDPOINT, {
          cache: "no-cache",
          credentials: "omit",
          headers: { Accept: "application/json" },
          mode: "cors",
          signal: controller.signal,
        })
        if (!response.ok) return fallback()
        const contentLength = Number(response.headers.get("content-length"))
        if (
          Number.isFinite(contentLength) &&
          contentLength > ROOM_APP_CATALOG_MAX_BYTES
        ) {
          await response.body?.cancel()
          return fallback()
        }
        const body = await readBoundedCatalogBody(
          response,
          ROOM_APP_CATALOG_MAX_BYTES
        )
        if (body === null) return fallback()
        const parsed = parseRoomAppCatalog(JSON.parse(body))
        if (!parsed) return fallback()
        hasAcceptedRemoteCatalog = true
        return parsed
      } catch {
        return fallback()
      } finally {
        clearTimeout(timer)
      }
    })().then((catalog) => {
      result = catalog
      expiresAt = now() + cacheTtlMs
      pending = null
      return catalog
    })
    return pending
  }
}

const loadBrowserRoomAppCatalog = createRoomAppCatalogLoader(
  (input, init) => fetch(input, init),
  BROWSER_ROOM_APP_CATALOG_CACHE_TTL_MS
)
const serviceCatalogLoaders = new WeakMap<
  RoomAppCatalogService,
  () => Promise<readonly RoomAppDefinition[]>
>()

/** Valid remote data is authoritative; before that, failures fail closed. */
export function loadProductionRoomAppCatalog(
  service?: RoomAppCatalogService
): Promise<readonly RoomAppDefinition[]> {
  if (!service) return loadBrowserRoomAppCatalog()
  let loader = serviceCatalogLoaders.get(service)
  if (!loader) {
    loader = createRoomAppCatalogLoader((input, init) =>
      service.fetch(input, init)
    )
    serviceCatalogLoaders.set(service, loader)
  }
  return loader()
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
  | "duplicate_request_id"
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
      shared?: {
        revision: number
        state: Record<string, unknown>
      }
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
  | {
      type: "shared_state"
      appInstanceId: string
      revision: number
      state: Record<string, unknown>
      sourceParticipantId?: string
    }
  | ({ type: "unicast_result" } & RoomAppUnicastResult)
  | {
      type: "error"
      appInstanceId: string
      error: "unsupported_message" | "rate_limited"
    }
  | {
      type: "error"
      appInstanceId: string
      requestId: string
      error:
        | "rate_limited"
        | "payload_too_large"
        | "delivery_unavailable"
        | "too_many_pending"
        | "duplicate_request_id"
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
      requestId: string
      targetParticipantId: string
      payload: Record<string, unknown>
    }
  | {
      type: "milestone"
      appInstanceId: string
      milestone: "engaged"
    }
  | {
      type: "sendGeneratedState"
      appInstanceId: string
      expectedRevision: number
      state: Record<string, unknown>
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
    value.type === "milestone" &&
    value.milestone === "engaged" &&
    Object.keys(value).length === 3
  )
    return { type: "milestone", appInstanceId, milestone: "engaged" }
  if (value.type === "sendGeneratedState") {
    if (
      typeof value.expectedRevision !== "number" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 0 ||
      !isRecord(value.state)
    )
      return null
    return {
      type: "sendGeneratedState",
      appInstanceId,
      expectedRevision: value.expectedRevision,
      state: value.state,
    }
  }
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
    if (!isValidRoomAppRequestId(value.requestId)) return null
    if (!isValidRoomAppParticipantId(value.targetParticipantId)) return null
    const payload = validateRoomAppPayload(value.payload)
    if (!payload.ok) return null
    return {
      type: "sendReliableTo",
      appInstanceId,
      requestId: value.requestId,
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
  return currentRoomAppCatalog().some(
    (app) =>
      validateRoomAppDefinition(app) &&
      isRoomAppAllowlisted(app) &&
      roomAppInstanceId(roomName, app.id) === appInstanceId
  )
}

export function validateRoomAppDefinition(app: RoomAppDefinition): boolean {
  try {
    if (app.source === "generated")
      return (
        app.id.length > 0 &&
        app.id.length <= 128 &&
        app.label.length > 0 &&
        app.label.length <= 80 &&
        typeof app.srcDoc === "string" &&
        app.srcDoc.length > 0 &&
        app.srcDoc.length <= 64 * 1024
      )
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
  if (app.source === "generated") return validateRoomAppDefinition(app)
  return currentRoomAppCatalog().some(
    (candidate) =>
      candidate.id === app.id &&
      candidate.url === app.url &&
      candidate.origin === app.origin &&
      candidate.origin === ROOM_APP_TRUSTED_ORIGIN &&
      validateRoomAppDefinition(candidate)
  )
}

/** Resolve a URL query value only to an exact, validated production App id. */
export function resolveProductionRoomAppId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const app = currentRoomAppCatalog().find(
    (candidate) => candidate.id === value
  )
  return app && validateRoomAppDefinition(app) && isRoomAppAllowlisted(app)
    ? app.id
    : null
}

/** Build a Room invite without carrying arbitrary query parameters forward. */
export function buildRoomInviteUrl({
  origin,
  roomName,
  roomType,
  appId,
}: {
  origin: string
  roomName: string
  roomType: "audio" | "screenshare"
  appId?: unknown
}): string {
  const url = new URL("/room", origin)
  url.searchParams.set("id", roomName)
  if (roomType === "screenshare") url.searchParams.set("type", "screenshare")
  const productionAppId = resolveProductionRoomAppId(appId)
  if (productionAppId) url.searchParams.set("app", productionAppId)
  return url.toString()
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
