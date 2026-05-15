import type { NextApiRequest, NextApiResponse } from "next"
import { getCloudflareContext } from "@opennextjs/cloudflare"

interface Env {
  ROOMS_KV: KVNamespace
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  RTK_APP_ID: string
  RTK_PRESET_NAME: string
}

interface RoomRecord {
  meetingId: string
  createdAt: number
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
  await env.ROOMS_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_S })
  return true
}

async function getOrCreateMeeting(roomName: string, env: Env): Promise<{ meetingId: string; expired: boolean }> {
  const key = `room:${roomName}`
  const raw = await env.ROOMS_KV.get(key)

  if (raw) {
    const record: RoomRecord = JSON.parse(raw)
    if (Date.now() - record.createdAt > ROOM_MAX_AGE_MS) {
      await env.ROOMS_KV.delete(key)
      // Close the RTK meeting so old tokens can no longer join
      await fetch(`${rtkBase(env)}/meetings/${record.meetingId}`, {
        method: "PATCH",
        headers: authHeaders(env),
        body: JSON.stringify({ status: "INACTIVE" }),
      }).catch(() => {})
      return { meetingId: "", expired: true }
    }
    return { meetingId: record.meetingId, expired: false }
  }

  const res = await fetch(`${rtkBase(env)}/meetings`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ title: roomName }),
  })
  const data = (await res.json()) as any
  const meetingId = data.data.id

  const record: RoomRecord = { meetingId, createdAt: Date.now() }
  await env.ROOMS_KV.put(key, JSON.stringify(record), {
    expirationTtl: 30 * 24 * 3600,
  })
  return { meetingId, expired: false }
}

async function addParticipant(meetingId: string, name: string, env: Env): Promise<string> {
  const presetName = env.RTK_PRESET_NAME || "group_call_host"
  const res = await fetch(`${rtkBase(env)}/meetings/${meetingId}/participants`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({
      name,
      preset_name: presetName,
      custom_participant_id: crypto.randomUUID(),
    }),
  })
  const data = (await res.json()) as any
  return data.data.token
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

    // KV-based rate limiting per IP (fallback for free plan without WAF)
    if (!isDev) {
      const ip = (req.headers["cf-connecting-ip"] as string) ?? (cf as any)?.ip ?? "unknown"
      const allowed = await checkRateLimit(ip, cfEnv)
      if (!allowed) {
        return res.status(429).json({ error: "Too many requests" })
      }
    }

    const { room, name } = req.body as { room: string; name: string }

    // Input validation
    if (!room || !name) {
      return res.status(400).json({ error: "room and name required" })
    }
    if (typeof room !== "string" || typeof name !== "string") {
      return res.status(400).json({ error: "invalid input" })
    }
    if (room.length > MAX_ROOM_LENGTH || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: "input too long" })
    }
    if (!room.trim() || !name.trim()) {
      return res.status(400).json({ error: "room and name must not be blank" })
    }

    const { meetingId, expired } = await getOrCreateMeeting(room.trim(), cfEnv)
    if (expired) {
      return res.status(410).json({ error: "room expired" })
    }

    const authToken = await addParticipant(meetingId, name.trim(), cfEnv)
    return res.status(200).json({ authToken })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: "internal error" })
  }
}
