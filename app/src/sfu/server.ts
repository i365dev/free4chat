import type { SfuSessionResponse, SfuTrack, ParticipantKind } from "./types"
import { isAllowedOrigin } from "../common/origin"
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
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

function originAllowed(request: Request, env: SfuEnv): boolean {
  return isAllowedOrigin(request.headers.get("Origin"))
}

function getAppCredentials(
  env: SfuEnv
): { appId: string; appSecret: string } | null {
  const appId = env.SFU_APP_ID
  const appSecret = env.SFU_APP_SECRET
  return appId && appSecret ? { appId, appSecret } : null
}

async function checkRateLimit(request: Request, env: SfuEnv): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown"
  const key = `sfu:rl:${ip}`
  const raw = await env.ROOMS_KV.get(key)
  const count = raw ? Number.parseInt(raw, 10) : 0
  if (count >= RATE_LIMIT_MAX) return false
  await env.ROOMS_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_S,
  })
  return true
}

async function verifyTurnstile(token: unknown, env: SfuEnv): Promise<boolean> {
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
  dataChannelSessionId?: string
): Promise<Response> {
  return roomControl(env, roomName, {
    action: "authorize",
    participantId,
    token,
    sessionId,
    trackSessionId,
    trackName,
    dataChannelSessionId,
  })
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
    `https://rtc.live.cloudflare.com/apps/${encodeURIComponent(
      credentials.appId
    )}${path}`,
    { ...init, headers }
  )
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
  if (!originAllowed(request, env))
    return json({ error: "forbidden_origin" }, 403)
  const url = new URL(request.url)
  const route = url.pathname.replace(/^\/api\/sfu\/?/, "")

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
    const kind: ParticipantKind = body.kind === "agent" ? "agent" : "human"
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
          enableBot: body.enableBot === true,
          participant: {
            id: participantId,
            name,
            kind,
            sessionId: session.sessionId,
            muted: false,
            tracks: [],
            joinedAt: Date.now(),
            token: participantToken,
          },
        })
    if (!roomResponse.ok) return roomResponse
    const registered = (await roomResponse.json()) as {
      expiresAt?: number
      botEnabled?: boolean
    }
    const result: SfuSessionResponse = {
      participantId,
      participantToken,
      sessionId: session.sessionId,
      expiresAt: registered.expiresAt ?? Date.now() + 2 * 60 * 60 * 1000,
      botEnabled: registered.botEnabled === true,
    }
    return json(result)
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
    const auth = await authorize(env, room, participantId, token, sessionId)
    if (!auth.ok) return auth
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
          : undefined
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

    if (route === "tracks" && Array.isArray(body.tracks)) {
      for (const track of body.tracks as Array<Record<string, unknown>>) {
        if (track.location !== "local" || typeof track.trackName !== "string")
          continue
        const kind: SfuTrack["kind"] =
          track.kind === "video" ? "video" : "audio"
        await roomControl(env, room, {
          action: "publish",
          participantId,
          token,
          track: { trackName: track.trackName, kind },
        })
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
        : undefined
    )
    if (!auth.ok) return auth
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
          channel.sessionId
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
