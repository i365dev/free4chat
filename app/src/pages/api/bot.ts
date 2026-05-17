import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { NextApiRequest, NextApiResponse } from "next"

interface RoomRecord {
  meetingId: string
  createdAt: number
  roomType: "audio" | "screenshare"
  botEnabled?: boolean
}

const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000

interface Env {
  ROOMS_KV: KVNamespace
  BOT_SESSION: DurableObjectNamespace
}

const ALLOWED_ORIGINS = [
  "https://free4.chat",
  "https://www.free4.chat",
  "https://free4chat.i365.workers.dev",
]

const RATE_LIMIT_WINDOW_S = 3600
const RATE_LIMIT_MAX = 30
const MAX_MESSAGE_LENGTH = 1000

async function checkRateLimit(ip: string, env: Env): Promise<boolean> {
  const key = `bot-rl:${ip}`
  const raw = await env.ROOMS_KV.get(key)
  const count = raw ? parseInt(raw, 10) : 0
  if (count >= RATE_LIMIT_MAX) return false
  await env.ROOMS_KV.put(key, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_S,
  })
  return true
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

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

    const { room, userMessage, userName } = req.body as {
      room: string
      userMessage: string
      userName: string
    }

    if (
      !room ||
      !userMessage ||
      !userName ||
      typeof room !== "string" ||
      typeof userMessage !== "string" ||
      typeof userName !== "string"
    ) {
      return res
        .status(400)
        .json({ error: "room, userMessage, userName required" })
    }

    if (userMessage.length > MAX_MESSAGE_LENGTH || userName.length > 32) {
      return res.status(400).json({ error: "input too long" })
    }

    const roomRaw = await cfEnv.ROOMS_KV.get(`room:${room.trim()}`)
    if (!roomRaw) {
      return res.status(404).json({ error: "room not found" })
    }
    const roomRecord: RoomRecord = JSON.parse(roomRaw)
    if (Date.now() - roomRecord.createdAt > ROOM_MAX_AGE_MS) {
      return res.status(410).json({ error: "room expired" })
    }
    if (!roomRecord.botEnabled) {
      return res
        .status(403)
        .json({ error: "AI assistant not enabled for this room" })
    }

    const id = cfEnv.BOT_SESSION.idFromName(
      `room:${roomRecord.meetingId}:${roomRecord.createdAt}`
    )
    const stub = cfEnv.BOT_SESSION.get(id)
    const doRes = await stub.fetch("https://bot/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userMessage: userMessage.trim(),
        userName: userName.trim(),
      }),
    })

    const data = (await doRes.json()) as { reply?: string; error?: string }
    if (!doRes.ok || data.error) {
      if (data.error === "rate_limited") {
        return res
          .status(429)
          .json({ error: "Luna has reached her hourly reply limit." })
      }
      console.error("[api/bot] DO error:", data.error)
      return res.status(500).json({
        error: "Luna is unavailable right now. Please try again later.",
      })
    }

    return res.status(200).json({ reply: data.reply })
  } catch (err) {
    console.error("[/api/bot]", err)
    return res.status(500).json({ error: "internal error" })
  }
}
