import type { SfuSessionResponse, SfuTrack } from "./types"
import { isAllowedOrigin } from "../common/origin"
import { resolveAgentPurposePermission } from "../do/meetingNotesAuth"
import { closeRealtimeTracks } from "../do/realtimeMedia"
import type { RoomSession } from "../do/RoomSession"

const MAX_ROOM_LENGTH = 64
const MAX_NAME_LENGTH = 32
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_S = 60

export interface SfuEnv {
  SFU_ROOM: DurableObjectNamespace<RoomSession>
  ROOMS_KV: KVNamespace
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
  TURNSTILE_SECRET_KEY?: string
  // Explicit, reversible development/E2E bypass. Any value other than the
  // literal string "true" preserves the normal Turnstile behavior below.
  TURNSTILE_DISABLED?: string
  // Coarse, environment-wide master switch for Agent SFU media (#82).
  // Absent/anything other than "true" => agent-session/agent-room-media
  // reject unconditionally, and RoomSession also refuses to ever start a
  // room-visible Meeting Notes grant (its "meeting-notes-start" WS
  // handler). The *real* per-room authorization boundary is the explicit,
  // human-visible Meeting Notes grant enforced by RoomSession
  // (isAgentAuthorizedForMedia) — this switch is only ever an AND on top of
  // that grant, never a substitute for it: turning it on does not by
  // itself give any Agent audio access. Not set in the production deploy
  // workflow today.
  AGENT_MEDIA_ENABLED?: string
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

// Routes the non-browser Runtime (MediaBridge) legitimately calls with no
// Origin header at all. Scoped deliberately narrow: "session" (initial
// Human creation, Turnstile-gated) and "ws" keep requiring a real browser
// Origin, since there's no demonstrated non-browser caller for them.
const MISSING_ORIGIN_ALLOWED_ROUTES = new Set([
  "agent-session",
  "agent-room-media",
  "agent-track-active",
  "tracks",
  "renegotiate",
  // The resident, subscribe-only Meeting Notes Runtime has no browser Origin
  // but must establish its own WebRTC transport before it can pull Human
  // tracks. The route still performs the normal token/session/grant checks.
  "datachannels/establish",
])

// A present-but-wrong Origin is always rejected on every route (a browser
// can't lie about its own Origin, so this stops other websites' JS from
// calling these routes with a victim's browser). A *missing* Origin is
// only accepted on the routes above — see MISSING_ORIGIN_ALLOWED_ROUTES —
// matching how /mcp already treats non-browser callers (its own
// allowedOriginHostnames). Everywhere else, a missing Origin is rejected
// exactly like an invalid one, same as before this route-scoping existed.
function originAllowed(request: Request, route: string): boolean {
  const origin = request.headers.get("Origin")
  if (origin === null) return MISSING_ORIGIN_ALLOWED_ROUTES.has(route)
  return isAllowedOrigin(origin)
}

function getAppCredentials(
  env: SfuEnv
): { appId: string; appSecret: string } | null {
  const appId = env.SFU_APP_ID
  const appSecret = env.SFU_APP_SECRET
  return appId && appSecret ? { appId, appSecret } : null
}

// Not a real authorization boundary — see AGENT_MEDIA_ENABLED's own
// comment. This only decides whether the Phase-0 dev/test escape hatch is
// switched on at all; agent-room-media/agent-session still separately
// require a valid, DO-verified agent participant token either way.
function agentMediaEnabled(env: SfuEnv): boolean {
  return env.AGENT_MEDIA_ENABLED === "true"
}

async function checkRateLimit(
  request: Request,
  env: SfuEnv,
  keyPrefix = "sfu:rl"
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown"
  const key = `${keyPrefix}:${ip}`
  const raw = await env.ROOMS_KV.get(key)
  const count = raw ? Number.parseInt(raw, 10) : 0
  if (count >= RATE_LIMIT_MAX) return false
  await env.ROOMS_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_S,
  })
  return true
}

async function verifyTurnstile(token: unknown, env: SfuEnv): Promise<boolean> {
  if (env.TURNSTILE_DISABLED === "true") return true
  if (!env.TURNSTILE_SECRET_KEY) return true
  if (typeof token !== "string" || !token) return false
  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  })
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  )
  if (!response.ok) return false
  const result = (await response.json()) as { success?: boolean }
  return result.success === true
}

async function roomControl(
  env: SfuEnv,
  roomName: string,
  body: unknown
): Promise<Response> {
  const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(roomName))
  return stub.fetch("https://room/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function authorize(
  env: SfuEnv,
  roomName: string,
  participantId: string,
  token: string,
  sessionId?: string,
  trackSessionId?: string,
  trackName?: string,
  dataChannelSessionId?: string,
  // Round 5 (P2): when about to request this many new Agent remote-
  // subscribe tracks from Cloudflare, asks the DO's "authorize" action to
  // also preflight-check pending-cleanup and active-mid capacity *before*
  // any Cloudflare tracks/new call is made — never sent for a Human caller
  // or for renegotiate (which creates no new tracks). See the "tracks"
  // route below.
  remoteTrackCount?: number,
  purpose?: unknown,
  wantsVoicePublish?: boolean,
  localTrackCount?: number
): Promise<Response> {
  return roomControl(env, roomName, {
    action: "authorize",
    participantId,
    token,
    sessionId,
    trackSessionId,
    trackName,
    dataChannelSessionId,
    remoteTrackCount,
    purpose,
    wantsVoicePublish,
    localTrackCount,
  })
}

// The exact DataChannel shape the resident Agent's shared-session bootstrap
// is allowed to establish (#83 review): the remote "server-events" channel
// and nothing else.
function isServerEventsDataChannel(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const channel = value as Record<string, unknown>
  return (
    channel.location === "remote" && channel.dataChannelName === "server-events"
  )
}

async function realtimeRequest(
  env: SfuEnv,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const credentials = getAppCredentials(env)
  if (!credentials) return json({ error: "sfu_not_configured" }, 503)
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${credentials.appSecret}`)
  headers.set("Content-Type", "application/json")
  return fetch(
    `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(
      credentials.appId
    )}${path}`,
    { ...init, headers }
  )
}

const MAX_DIAGNOSTIC_TRACK_COUNT = 100
const MAX_DIAGNOSTIC_ERROR_CODE_LENGTH = 64
const DIAGNOSTIC_LOOKUP_TIMEOUT_MS = 3000

function boundedDiagnosticErrorCode(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.slice(0, MAX_DIAGNOSTIC_ERROR_CODE_LENGTH)
    : undefined
}

function parsedObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function summarizeRemoteTrackResponse(
  status: number,
  responseBody: string
): {
  upstreamStatus: number
  requiresImmediateRenegotiation: boolean
  hasSessionDescription: boolean
  sessionDescriptionType: string | null
  trackResultCount: number
  trackHasMid: boolean
  topLevelErrorCode?: string
  trackErrorCodes: string[]
} {
  const response = parsedObject(responseBody)
  const sessionDescription =
    response?.sessionDescription &&
    typeof response.sessionDescription === "object"
      ? (response.sessionDescription as Record<string, unknown>)
      : undefined
  const tracks = Array.isArray(response?.tracks)
    ? response.tracks.slice(0, MAX_DIAGNOSTIC_TRACK_COUNT)
    : []
  const trackErrorCodes = tracks
    .map((track) =>
      track && typeof track === "object"
        ? boundedDiagnosticErrorCode(
            (track as Record<string, unknown>).errorCode
          )
        : undefined
    )
    .filter((code): code is string => Boolean(code))
    .filter((code, index, all) => all.indexOf(code) === index)
    .slice(0, 4)
  return {
    upstreamStatus: status,
    requiresImmediateRenegotiation:
      response?.requiresImmediateRenegotiation === true,
    hasSessionDescription: Boolean(sessionDescription),
    sessionDescriptionType:
      sessionDescription?.type === "offer" ||
      sessionDescription?.type === "answer"
        ? sessionDescription.type
        : null,
    trackResultCount: tracks.length,
    trackHasMid: tracks.some(
      (track) =>
        track &&
        typeof track === "object" &&
        typeof (track as Record<string, unknown>).mid === "string" &&
        ((track as Record<string, unknown>).mid as string).length > 0
    ),
    ...(boundedDiagnosticErrorCode(response?.errorCode)
      ? { topLevelErrorCode: boundedDiagnosticErrorCode(response?.errorCode) }
      : {}),
    trackErrorCodes,
  }
}

function usableSessionDescription(responseBody: string): boolean {
  const response = parsedObject(responseBody)
  const description =
    response?.sessionDescription &&
    typeof response.sessionDescription === "object"
      ? (response.sessionDescription as Record<string, unknown>)
      : undefined
  return typeof description?.sdp === "string" && description.sdp.length > 0
}

type PublisherTrackStatus = "active" | "inactive" | "waiting" | "unknown"

function publisherTrackStatus(value: unknown): PublisherTrackStatus {
  return value === "active" || value === "inactive" || value === "waiting"
    ? value
    : "unknown"
}

async function diagnosePublisherSession(
  env: SfuEnv,
  publisherSessionId: string,
  requestedTrackName: string
): Promise<{
  publisherSessionLookupOk: boolean
  publisherTrackCount: number
  matchingTrackFound: boolean
  matchingTrackStatus: PublisherTrackStatus
  matchingTrackHasMid: boolean
}> {
  const failed = {
    publisherSessionLookupOk: false,
    publisherTrackCount: 0,
    matchingTrackFound: false,
    matchingTrackStatus: "unknown" as const,
    matchingTrackHasMid: false,
  }
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    DIAGNOSTIC_LOOKUP_TIMEOUT_MS
  )
  try {
    const response = await realtimeRequest(
      env,
      `/sessions/${encodeURIComponent(publisherSessionId)}`,
      { method: "GET", signal: controller.signal }
    )
    const body = await response.text()
    if (!response.ok) return failed
    const parsed = parsedObject(body)
    const tracks = Array.isArray(parsed?.tracks)
      ? parsed.tracks.slice(0, MAX_DIAGNOSTIC_TRACK_COUNT)
      : []
    const matching = tracks.find(
      (track) =>
        track &&
        typeof track === "object" &&
        (track as Record<string, unknown>).trackName === requestedTrackName
    )
    const matchingRecord =
      matching && typeof matching === "object"
        ? (matching as Record<string, unknown>)
        : undefined
    return {
      publisherSessionLookupOk: true,
      publisherTrackCount: tracks.length,
      matchingTrackFound: Boolean(matchingRecord),
      matchingTrackStatus: publisherTrackStatus(matchingRecord?.status),
      matchingTrackHasMid:
        typeof matchingRecord?.mid === "string" &&
        matchingRecord.mid.length > 0,
    }
  } catch {
    return failed
  } finally {
    clearTimeout(timeout)
  }
}

async function readBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export async function handleSfuRequest(
  request: Request,
  env: SfuEnv
): Promise<Response> {
  const url = new URL(request.url)
  const route = url.pathname.replace(/^\/api\/sfu\/?/, "")

  if (!originAllowed(request, route))
    return json({ error: "forbidden_origin" }, 403)

  if (route === "ws") {
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405)
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426)
    }
    const room = url.searchParams.get("room")
    const participantId = url.searchParams.get("participantId")
    const token = url.searchParams.get("token")
    if (!room || !participantId || !token)
      return json({ error: "bad_request" }, 400)
    const auth = await authorize(env, room, participantId, token)
    if (!auth.ok) return auth
    const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(room))
    const doUrl = new URL("https://room/ws")
    doUrl.searchParams.set("participantId", participantId)
    doUrl.searchParams.set("token", token)
    return stub.fetch(new Request(doUrl, request))
  }

  if (route === "session") {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)
    if (!(await checkRateLimit(request, env)))
      return json({ error: "rate_limited" }, 429)
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room.trim() : ""
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (body.kind === "agent") return badRequest("agent_sessions_not_supported")
    if (!room || room.length > MAX_ROOM_LENGTH)
      return badRequest("invalid_room")
    if (!name || name.length > MAX_NAME_LENGTH)
      return badRequest("invalid_name")

    const reconnect =
      body.reconnect && typeof body.reconnect === "object"
        ? (body.reconnect as Record<string, unknown>)
        : null
    const reconnectParticipantId =
      typeof reconnect?.participantId === "string"
        ? reconnect.participantId
        : ""
    const reconnectToken =
      typeof reconnect?.participantToken === "string"
        ? reconnect.participantToken
        : ""
    const reconnectSessionId =
      typeof reconnect?.sessionId === "string" ? reconnect.sessionId : ""
    const isReconnect = Boolean(
      reconnectParticipantId && reconnectToken && reconnectSessionId
    )
    if (isReconnect) {
      const auth = await authorize(
        env,
        room,
        reconnectParticipantId,
        reconnectToken,
        reconnectSessionId
      )
      if (!auth.ok) return auth
    } else if (!(await verifyTurnstile(body.turnstileToken, env))) {
      return json({ error: "verification_failed" }, 403)
    }

    const sessionResponse = await realtimeRequest(env, "/sessions/new", {
      method: "POST",
    })
    if (!sessionResponse.ok) {
      return json({ error: "sfu_session_failed" }, 502)
    }
    const session = (await sessionResponse.json()) as { sessionId?: string }
    if (!session.sessionId) return json({ error: "sfu_session_invalid" }, 502)

    const participantId = isReconnect
      ? reconnectParticipantId
      : crypto.randomUUID()
    const participantToken = isReconnect ? reconnectToken : crypto.randomUUID()
    const roomResponse = isReconnect
      ? await roomControl(env, room, {
          action: "reconnect",
          participantId,
          token: participantToken,
          sessionId: reconnectSessionId,
          newSessionId: session.sessionId,
        })
      : await roomControl(env, room, {
          action: "register",
          participant: {
            id: participantId,
            name,
            kind: "human",
            media: {
              sessionId: session.sessionId,
              muted: false,
              fileChannelReady: false,
              tracks: [],
            },
            joinedAt: Date.now(),
            token: participantToken,
          },
        })
    if (!roomResponse.ok) return roomResponse
    const registered = (await roomResponse.json()) as {
      expiresAt?: number
    }
    const result: SfuSessionResponse = {
      participantId,
      participantToken,
      sessionId: session.sessionId,
      // The room itself has no fixed lifetime while occupied (see
      // RoomSession's empty-room expiry); this is only a defensive fallback
      // for the (should-never-happen) case where the DO's response omits it.
      expiresAt: registered.expiresAt ?? Date.now() + 365 * 24 * 60 * 60 * 1000,
    }
    return json(result)
  }

  if (route === "agent-session") {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)
    if (!agentMediaEnabled(env))
      return json({ error: "agent_media_disabled" }, 403)
    // Bounded separately from Human session creation (own KV key prefix,
    // same window/primitive) — a legitimate Runtime restart/reconnect
    // stays well under this; a tight retry loop does not.
    if (!(await checkRateLimit(request, env, "sfu:rl:agent-session")))
      return json({ error: "rate_limited" }, 429)
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room : ""
    const participantId =
      typeof body.participantId === "string" ? body.participantId : ""
    const token = typeof body.token === "string" ? body.token : ""
    if (!room || !participantId || !token) return badRequest("missing_session")
    // Confirms the caller is an existing, authorized *agent* participant
    // before spending a real Cloudflare Realtime session on it. Reuses the
    // same DO auth path as everything else — no separate credential system.
    // #83 review: admission for the ONE shared Agent session is
    // meetingNotes OR voiceReply (agent-media-admit) — never Human media
    // discovery, which stays agent-room-media/Meeting-Notes-only.
    const authResponse = await roomControl(env, room, {
      action: "agent-media-admit",
      participantId,
      token,
    })
    if (!authResponse.ok) return authResponse

    const sessionResponse = await realtimeRequest(env, "/sessions/new", {
      method: "POST",
    })
    if (!sessionResponse.ok) return json({ error: "sfu_session_failed" }, 502)
    const session = (await sessionResponse.json()) as { sessionId?: string }
    if (!session.sessionId) return json({ error: "sfu_session_invalid" }, 502)

    const attachResponse = await roomControl(env, room, {
      action: "agent-media-attach",
      participantId,
      token,
      sessionId: session.sessionId,
    })
    if (!attachResponse.ok) return attachResponse
    return json({ sessionId: session.sessionId })
  }

  if (route === "agent-room-media") {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)
    if (!agentMediaEnabled(env))
      return json({ error: "agent_media_disabled" }, 403)
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room : ""
    const participantId =
      typeof body.participantId === "string" ? body.participantId : ""
    const token = typeof body.token === "string" ? body.token : ""
    if (!room || !participantId || !token) return badRequest("missing_session")
    return roomControl(env, room, {
      action: "agent-room-media",
      participantId,
      token,
    })
  }

  if (route === "agent-track-active") {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)
    if (!agentMediaEnabled(env))
      return json({ error: "agent_media_disabled" }, 403)
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room : ""
    const participantId =
      typeof body.participantId === "string" ? body.participantId : ""
    const token = typeof body.token === "string" ? body.token : ""
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    const trackName = typeof body.trackName === "string" ? body.trackName : ""
    if (!room || !participantId || !token || !sessionId || !trackName)
      return badRequest("missing_track")
    const authResponse = await authorize(
      env,
      room,
      participantId,
      token,
      sessionId,
      undefined,
      undefined,
      undefined,
      undefined,
      "voice-reply",
      true
    )
    if (!authResponse.ok) return authResponse
    const publisher = await diagnosePublisherSession(env, sessionId, trackName)
    const active =
      publisher.matchingTrackFound &&
      publisher.matchingTrackStatus === "active" &&
      publisher.matchingTrackHasMid
    if (!active) return json({ active: false })
    const activation = await roomControl(env, room, {
      action: "agent-track-active",
      participantId,
      token,
      sessionId,
      trackName,
    })
    if (!activation.ok) return activation
    return json({ active: true })
  }

  if (route === "tracks" || route === "renegotiate") {
    if (request.method !== "POST" && request.method !== "PUT") {
      return json({ error: "method_not_allowed" }, 405)
    }
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room : ""
    const participantId =
      typeof body.participantId === "string" ? body.participantId : ""
    const token = typeof body.token === "string" ? body.token : ""
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    if (!room || !participantId || !token || !sessionId)
      return badRequest("missing_session")
    const requestedTracks = Array.isArray(body.tracks)
      ? (body.tracks as Array<Record<string, unknown>>)
      : []
    // Round 5 (P2): known *before* any Cloudflare call — how many new
    // remote-subscribe tracks this request would create, so the DO can
    // preflight-check capacity and reject before tracks/new ever runs
    // (rather than only after, once Cloudflare has already created a
    // subscription that would immediately fail to register).
    const remoteTrackCount = requestedTracks.filter(
      (track) => track.location === "remote"
    ).length
    const localTracks = requestedTracks.filter(
      (track) => track.location === "local"
    )
    const auth = await authorize(
      env,
      room,
      participantId,
      token,
      sessionId,
      undefined,
      undefined,
      undefined,
      remoteTrackCount,
      typeof body.purpose === "string" ? body.purpose : undefined,
      body.wantsVoicePublish === true,
      localTracks.length
    )
    if (!auth.ok) return auth
    // The DO's "authorize" action now also re-checks the current Meeting
    // Notes grant for an agent participant (finding #2) — so `kind` here
    // doubles as proof that, as of this call, an agent caller is still the
    // authorized note-taker. Read once and reused below for the mid-capture
    // step that lets a *future* revocation actually close what gets
    // subscribed in this same call.
    const { kind: participantKind } = (await auth.json()) as { kind?: string }
    // Phase-0 (#82) invariant: an agent's media session is subscribe-only.
    // Reject a "local" (publish) track *before* it ever reaches Cloudflare
    // Realtime — rejecting only RoomSession's later `publish` bookkeeping
    // would be too late, since the upstream SFU publication could already
    // have succeeded by then. Human publishing is completely unaffected.

    // #83 security gate: admit an Agent local publication only when
    // AGENT_MEDIA_ENABLED is on AND purpose is "voice-reply" AND the
    // voiceReply grant names THIS participant (the DO "authorize" above owns
    // that room-state check) AND the request carries exactly one local audio
    // track and no remote tracks. Everything fails closed BEFORE any
    // Cloudflare tracks/new call.
    if (
      route === "tracks" &&
      participantKind === "agent" &&
      localTracks.length > 0
    ) {
      if (!agentMediaEnabled(env))
        return json({ error: "agent_media_disabled" }, 403)
      // From ACTUAL requested kinds, never a client-declared flag; unknown
      // kinds fail closed like video.
      const involvesVideo = localTracks.some((track) => track.kind !== "audio")
      const direction = resolveAgentPurposePermission({
        purpose: body.purpose,
        wantsLocalPublish: true,
        wantsRemoteSubscribe: remoteTrackCount > 0,
        involvesVideo,
      })
      if (direction.ok === false) {
        return json({ error: direction.error }, 403)
      }
      if (localTracks.length !== 1)
        return json({ error: "agent_publish_invalid_track_count" }, 403)
    }
    for (const remoteTrack of requestedTracks.filter(
      (track) => track.location === "remote"
    )) {
      const remoteAuth = await authorize(
        env,
        room,
        participantId,
        token,
        sessionId,
        typeof remoteTrack.sessionId === "string"
          ? remoteTrack.sessionId
          : undefined,
        typeof remoteTrack.trackName === "string"
          ? remoteTrack.trackName
          : undefined,
        undefined,
        undefined,
        // #83 review: purpose must reach the DO's per-remote-track
        // reauthorization too, so a Meeting Notes revocation between the
        // first authorize and this one still fails the request closed.
        typeof body.purpose === "string" ? body.purpose : undefined
      )
      if (!remoteAuth.ok) return remoteAuth
    }

    const upstreamBody =
      route === "tracks"
        ? { tracks: body.tracks, sessionDescription: body.sessionDescription }
        : { sessionDescription: body.sessionDescription }
    const upstream = await realtimeRequest(
      env,
      `/sessions/${encodeURIComponent(sessionId)}/${
        route === "tracks" ? "tracks/new" : "renegotiate"
      }`,
      {
        method: route === "tracks" ? "POST" : "PUT",
        body: JSON.stringify(upstreamBody),
      }
    )
    const responseBody = await upstream.text()
    if (!upstream.ok)
      return new Response(responseBody, { status: upstream.status })

    // Production-only diagnostic for the Human remote-subscribe path. A
    // successful tracks/new response should carry an SFU-generated offer;
    // when it does not, inspect the publisher session without changing the
    // response returned to the browser. Never log the publisher session ID,
    // requested track name, credentials, raw body, SDP, or descriptions.
    const firstHumanRemoteTrack =
      route === "tracks" && participantKind === "human"
        ? requestedTracks.find((track) => track.location === "remote")
        : undefined
    if (
      firstHumanRemoteTrack &&
      !usableSessionDescription(responseBody) &&
      typeof firstHumanRemoteTrack.sessionId === "string" &&
      typeof firstHumanRemoteTrack.trackName === "string"
    ) {
      const responseSummary = summarizeRemoteTrackResponse(
        upstream.status,
        responseBody
      )
      const publisherSummary = await diagnosePublisherSession(
        env,
        firstHumanRemoteTrack.sessionId,
        firstHumanRemoteTrack.trackName
      )
      console.warn("sfu_remote_subscribe_diagnostic", {
        ...responseSummary,
        ...publisherSummary,
      })
    }

    if (route === "tracks" && Array.isArray(body.tracks)) {
      for (const track of body.tracks as Array<Record<string, unknown>>) {
        if (track.location !== "local" || typeof track.trackName !== "string")
          continue
        // #83: an Agent's publication is booked through the grant-rechecking
        // "agent-track-published" action below — never this Human track-list
        // action, which rejects agents outright.
        if (participantKind === "agent") continue
        const trackKind: SfuTrack["kind"] =
          track.kind === "video" ? "video" : "audio"
        await roomControl(env, room, {
          action: "publish",
          participantId,
          token,
          track: { trackName: track.trackName, kind: trackKind },
        })
      }
      // Record the Cloudflare-assigned mid(s) for the Agent's newly
      // established *remote* (subscribe) tracks, so a future Meeting Notes
      // revocation can actually close them server-side (finding #3) instead
      // of only blocking future subscriptions. Never done for a Human's own
      // subscriptions — only the granted Agent's Human-audio ingress needs
      // this bookkeeping.
      const hasRemoteTrack = requestedTracks.some(
        (track) => track.location === "remote"
      )
      // #83: capture the published mid for the voiceReply-granted agent so
      // Stop/reassignment can actively close it; TOCTOU failure closes the
      // just-created publication and hands unresolved mids to pending
      // cleanup instead of reporting stale success.
      if (participantKind === "agent" && localTracks.length > 0) {
        let upstreamJson: { tracks?: Array<{ mid?: unknown }> } = {}
        try {
          upstreamJson = JSON.parse(responseBody)
        } catch {
          // Empty-mid fail-closed check below handles parse failure.
        }
        const publishedMid = (upstreamJson.tracks ?? [])
          .map((track) => track.mid)
          .find(
            (mid): mid is string => typeof mid === "string" && mid.length > 0
          )
        const publishTrackName =
          typeof localTracks[0]!.trackName === "string"
            ? localTracks[0]!.trackName
            : "agent-voice"
        if (!publishedMid)
          return json({ error: "agent_publication_unverifiable" }, 502)
        const registered = await roomControl(env, room, {
          action: "agent-track-published",
          participantId,
          token,
          sessionId,
          mid: publishedMid,
          trackName: publishTrackName,
        })
        if (!registered.ok) {
          const closed = await closeRealtimeTracks(env, sessionId, [
            publishedMid,
          ])
          if (!closed) {
            await roomControl(env, room, {
              action: "agent-media-cleanup-pending",
              sessionId,
              mids: [publishedMid],
            })
          }
          return registered
        }
      }
      if (participantKind === "agent" && hasRemoteTrack) {
        let upstreamJson: { tracks?: Array<{ mid?: unknown }> } = {}
        try {
          upstreamJson = JSON.parse(responseBody)
        } catch {
          // Handled by the empty-mids fail-closed check below.
        }
        const remoteMids = (upstreamJson.tracks ?? [])
          .map((track) => track.mid)
          .filter(
            (mid): mid is string => typeof mid === "string" && mid.length > 0
          )
        // An Agent remote subscription whose upstream response carries no
        // usable mid can never be revoked later — Cloudflare's tracks/close
        // needs exactly that mid. A 2xx upstream status alone is not
        // sufficient to report success: fail closed rather than silently
        // reporting a subscription the server could never actually enforce
        // Stop against.
        if (remoteMids.length === 0)
          return json({ error: "agent_subscription_unverifiable" }, 502)

        const registerResponse = await roomControl(env, room, {
          action: "agent-track-subscribed",
          participantId,
          token,
          sessionId,
          mids: remoteMids,
        })
        if (!registerResponse.ok) {
          // TOCTOU (Blocker 2): the grant was revoked or reassigned between
          // the authorize() check above and this point — Cloudflare already
          // created the subscription upstream, so it must be actively
          // closed rather than left untracked and unrevocable. Never report
          // the original upstream success to the Agent in this case.
          const closed = await closeRealtimeTracks(env, sessionId, remoteMids)
          if (!closed) {
            // The abort-path close itself didn't confirm — hand the mids to
            // RoomSession's pending-cleanup/retry mechanism rather than
            // losing track of them. Its result is not ignored: a failure
            // here means this specific untracked subscription may never
            // get retried, which is worth surfacing even though the Agent
            // still correctly receives the original registration failure
            // either way (never the stale Cloudflare success).
            const queued = await roomControl(env, room, {
              action: "agent-media-cleanup-pending",
              sessionId,
              mids: remoteMids,
            })
            if (!queued.ok) {
              console.error(
                "meeting_notes_cleanup_handoff_failed",
                room,
                sessionId
              )
            }
          }
          return registerResponse
        }
      }
    }
    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (route === "tracks/close") {
    if (request.method !== "PUT")
      return json({ error: "method_not_allowed" }, 405)
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room : ""
    const participantId =
      typeof body.participantId === "string" ? body.participantId : ""
    const token = typeof body.token === "string" ? body.token : ""
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    const tracks = Array.isArray(body.tracks)
      ? body.tracks.filter(
          (track): track is Record<string, unknown> =>
            Boolean(track) && typeof track === "object"
        )
      : []
    if (!room || !participantId || !token || !sessionId || !tracks.length)
      return badRequest("missing_track")
    if (tracks.some((track) => typeof track.mid !== "string"))
      return badRequest("invalid_track")
    const auth = await authorize(env, room, participantId, token, sessionId)
    if (!auth.ok) return auth
    const upstream = await realtimeRequest(
      env,
      `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
      {
        method: "PUT",
        body: JSON.stringify({
          tracks: tracks.map((track) => ({ mid: track.mid })),
          sessionDescription: body.sessionDescription,
          force: body.force === true,
        }),
      }
    )
    const responseBody = await upstream.text()
    if (!upstream.ok)
      return new Response(responseBody, { status: upstream.status })
    for (const track of tracks) {
      if (typeof track.trackName !== "string") continue
      await roomControl(env, room, {
        action: "unpublish",
        participantId,
        token,
        trackName: track.trackName,
      })
    }
    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (
    route === "datachannels/establish" ||
    route === "datachannels/new" ||
    route === "datachannels/close"
  ) {
    if (
      (route === "datachannels/close" && request.method !== "PUT") ||
      (route !== "datachannels/close" && request.method !== "POST")
    )
      return json({ error: "method_not_allowed" }, 405)
    const body = await readBody(request)
    if (!body) return badRequest("invalid_json")
    const room = typeof body.room === "string" ? body.room : ""
    const participantId =
      typeof body.participantId === "string" ? body.participantId : ""
    const token = typeof body.token === "string" ? body.token : ""
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    if (!room || !participantId || !token || !sessionId)
      return badRequest("missing_session")
    const auth = await authorize(
      env,
      room,
      participantId,
      token,
      sessionId,
      undefined,
      undefined,
      typeof body.publisherSessionId === "string"
        ? body.publisherSessionId
        : undefined,
      undefined,
      // #83 review: the shared initial transport is admitted only under an
      // explicit narrow purpose ("agent-transport") that the DO checks
      // against meetingNotes OR voiceReply — never Agent token alone.
      typeof body.purpose === "string" ? body.purpose : undefined
    )
    if (!auth.ok) return auth
    // #83 review: an Agent's datachannel access over the shared session is
    // exactly the bootstrap plumbing — establishing the single server-events
    // channel — plus close for cleaning that channel up. datachannels/new is
    // Human-only and any non-server-events establish shape fails closed,
    // both BEFORE any Cloudflare call.
    const { kind: dataChannelCallerKind } = (await auth.json()) as {
      kind?: string
    }
    if (dataChannelCallerKind === "agent") {
      if (route === "datachannels/new")
        return json({ error: "agent_datachannel_forbidden" }, 403)
      if (
        route === "datachannels/establish" &&
        !isServerEventsDataChannel(body.dataChannel)
      )
        return json({ error: "agent_datachannel_shape_forbidden" }, 403)
    }
    if (route === "datachannels/close") {
      const dataChannels = Array.isArray(body.dataChannels)
        ? body.dataChannels.filter(
            (channel): channel is Record<string, unknown> =>
              Boolean(channel) && typeof channel === "object"
          )
        : []
      if (
        !dataChannels.length ||
        dataChannels.some(
          (channel) =>
            typeof channel.id !== "number" ||
            (channel.sessionId !== undefined &&
              typeof channel.sessionId !== "string")
        )
      )
        return badRequest("invalid_data_channel")
      for (const channel of dataChannels) {
        if (typeof channel.sessionId !== "string") continue
        const channelAuth = await authorize(
          env,
          room,
          participantId,
          token,
          sessionId,
          undefined,
          undefined,
          channel.sessionId,
          undefined,
          typeof body.purpose === "string" ? body.purpose : undefined
        )
        if (!channelAuth.ok) return channelAuth
      }
      const upstream = await realtimeRequest(
        env,
        `/sessions/${encodeURIComponent(sessionId)}/datachannels/close`,
        {
          method: "PUT",
          body: JSON.stringify({
            dataChannels: dataChannels.map((channel) => ({
              id: channel.id,
              sessionId: channel.sessionId,
            })),
          }),
        }
      )
      const responseBody = await upstream.text()
      return new Response(responseBody, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      })
    }
    const upstreamBody =
      route === "datachannels/establish"
        ? {
            dataChannel: body.dataChannel,
            sessionDescription: body.sessionDescription,
          }
        : {
            dataChannels: body.dataChannels,
            sessionDescription: body.sessionDescription,
          }
    const upstream = await realtimeRequest(
      env,
      `/sessions/${encodeURIComponent(sessionId)}/${route}`,
      {
        method: "POST",
        body: JSON.stringify(upstreamBody),
      }
    )
    const responseBody = await upstream.text()
    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    })
  }

  return json({ error: "not_found" }, 404)
}
