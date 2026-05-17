import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { NextApiRequest, NextApiResponse } from "next"

interface Env {
  ROOMS_KV: KVNamespace
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  RTK_APP_ID: string
  RTK_PRESET_NAME: string
  RTK_SCREENSHARE_PRESET_NAME: string
  RTK_AUDIO_PRESET_NAME: string
  TURNSTILE_SECRET_KEY?: string
}

type RoomType = "audio" | "screenshare"

interface RoomRecord {
  meetingId: string
  createdAt: number
  roomType: RoomType
  botEnabled?: boolean
}

const ALLOWED_ORIGINS = [
  "https://free4.chat",
  "https://www.free4.chat",
  "https://free4chat.i365.workers.dev",
]

const MAX_ROOM_LENGTH = 64
const MAX_NAME_LENGTH = 32
const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000 // 2 hours
const RATE_LIMIT_WINDOW_S = 60
const RATE_LIMIT_MAX = 20

function rtkBase(env: Env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}`
}

function authHeaders(env: Env) {
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  }
}

async function checkRateLimit(ip: string, env: Env): Promise<boolean> {
  const key = `rl:${ip}`
  const raw = await env.ROOMS_KV.get(key)
  const count = raw ? parseInt(raw, 10) : 0
  if (count >= RATE_LIMIT_MAX) return false
  await env.ROOMS_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_S,
  })
  return true
}

async function getOrCreateMeeting(
  roomName: string,
  roomType: RoomType,
  enableBot: boolean,
  env: Env
): Promise<{
  meetingId: string
  expired: boolean
  roomType: RoomType
  typeConflict: boolean
  botEnabled: boolean
}> {
  const key = `room:${roomName}`
  const raw = await env.ROOMS_KV.get(key)

  if (raw) {
    const record: RoomRecord = JSON.parse(raw)
    if (Date.now() - record.createdAt > ROOM_MAX_AGE_MS) {
      await env.ROOMS_KV.delete(key)
      await fetch(`${rtkBase(env)}/meetings/${record.meetingId}`, {
        method: "PATCH",
        headers: authHeaders(env),
        body: JSON.stringify({ status: "INACTIVE" }),
      }).catch(() => {})
      return {
        meetingId: "",
        expired: true,
        roomType: record.roomType,
        typeConflict: false,
        botEnabled: false,
      }
    }
    const upgradeToScreenshare =
      record.roomType === "audio" && roomType === "screenshare"
    const shouldEnableBot = enableBot && !record.botEnabled
    if (upgradeToScreenshare || shouldEnableBot) {
      const upgraded: RoomRecord = {
        ...record,
        roomType: upgradeToScreenshare ? "screenshare" : record.roomType,
        botEnabled: record.botEnabled || enableBot,
      }
      await env.ROOMS_KV.put(key, JSON.stringify(upgraded), {
        expirationTtl: 30 * 24 * 3600,
      })
      return {
        meetingId: record.meetingId,
        expired: false,
        roomType: upgraded.roomType,
        typeConflict: upgradeToScreenshare
          ? false
          : record.roomType !== roomType,
        botEnabled: upgraded.botEnabled ?? false,
      }
    }
    return {
      meetingId: record.meetingId,
      expired: false,
      roomType: record.roomType,
      typeConflict: record.roomType !== roomType,
      botEnabled: record.botEnabled ?? false,
    }
  }

  const res = await fetch(`${rtkBase(env)}/meetings`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ title: roomName }),
  })
  if (!res.ok) throw new Error(`RTK meetings API error: ${res.status}`)
  const data = (await res.json()) as any
  const meetingId = data?.data?.id
  if (!meetingId) throw new Error("RTK meetings API returned no meeting ID")

  const record: RoomRecord = {
    meetingId,
    createdAt: Date.now(),
    roomType,
    botEnabled: enableBot,
  }
  await env.ROOMS_KV.put(key, JSON.stringify(record), {
    expirationTtl: 30 * 24 * 3600,
  })
  return {
    meetingId,
    expired: false,
    roomType,
    typeConflict: false,
    botEnabled: enableBot,
  }
}

async function addParticipant(
  meetingId: string,
  name: string,
  roomType: RoomType,
  env: Env
): Promise<string> {
  const presetName =
    roomType === "screenshare"
      ? env.RTK_SCREENSHARE_PRESET_NAME ||
        env.RTK_PRESET_NAME ||
        "group_call_host"
      : env.RTK_AUDIO_PRESET_NAME || "audio_only_room"
  const res = await fetch(
    `${rtkBase(env)}/meetings/${meetingId}/participants`,
    {
      method: "POST",
      headers: authHeaders(env),
      body: JSON.stringify({
        name,
        preset_name: presetName,
        custom_participant_id: crypto.randomUUID(),
      }),
    }
  )
  const data = (await res.json()) as any
  if (!res.ok) throw new Error(`RTK participants API error: ${res.status}`)
  const token = data?.data?.token
  if (!token) throw new Error("RTK participants API returned no token")
  return token
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Origin check — blocks cross-origin browser requests
  const origin = req.headers["origin"] as string | undefined
  const isDev = process.env.NODE_ENV === "development"
  if (!isDev && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    return res.status(403).json({ error: "Forbidden" })
  }

  try {
    const { env, cf } = getCloudflareContext()
    const cfEnv = env as unknown as Env

    const ip =
      (req.headers["cf-connecting-ip"] as string) ??
      (cf as any)?.ip ??
      "unknown"

    if (!isDev) {
      const allowed = await checkRateLimit(ip, cfEnv)
      if (!allowed) {
        return res.status(429).json({ error: "Too many requests" })
      }
    }

    const { room, name, type, enableBot, turnstileToken } = req.body as {
      room: string
      name: string
      type?: string
      enableBot?: boolean
      turnstileToken?: string
    }
    const roomType: RoomType = type === "screenshare" ? "screenshare" : "audio"

    if (
      !room ||
      !name ||
      typeof room !== "string" ||
      typeof name !== "string"
    ) {
      return res.status(400).json({ error: "room and name required" })
    }
    if (room.length > MAX_ROOM_LENGTH || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: "input too long" })
    }
    if (!room.trim() || !name.trim()) {
      return res.status(400).json({ error: "room and name must not be blank" })
    }

    if (!isDev && cfEnv.TURNSTILE_SECRET_KEY) {
      if (!turnstileToken) {
        return res
          .status(403)
          .json({ error: "Turnstile verification required" })
      }
      const verifyRes = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: cfEnv.TURNSTILE_SECRET_KEY,
            response: turnstileToken,
            remoteip: ip,
          }),
        }
      )
      const verifyData = (await verifyRes.json()) as { success: boolean }
      if (!verifyData.success) {
        return res.status(403).json({ error: "Turnstile verification failed" })
      }
    }

    const {
      meetingId,
      expired,
      roomType: resolvedRoomType,
      typeConflict,
      botEnabled: resolvedBotEnabled,
    } = await getOrCreateMeeting(
      room.trim(),
      roomType,
      enableBot ?? false,
      cfEnv
    )
    if (expired) {
      return res.status(410).json({ error: "room expired" })
    }

    const authToken = await addParticipant(
      meetingId,
      name.trim(),
      resolvedRoomType,
      cfEnv
    )
    return res.status(200).json({
      authToken,
      roomType: resolvedRoomType,
      typeConflict,
      botEnabled: resolvedBotEnabled,
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: "internal error" })
  }
}
