import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { NextApiRequest, NextApiResponse } from "next"

import { isAllowedOrigin } from "@common/origin"

const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000

interface Env {
  ROOMS_KV: KVNamespace
  BOT_SESSION: DurableObjectNamespace
  SFU_ROOM?: DurableObjectNamespace
}

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

async function getSfuRoomStatus(
  room: string,
  env: Env
): Promise<{ botEnabled: boolean; createdAt: number } | null> {
  if (!env.SFU_ROOM) return null
  const stub = env.SFU_ROOM.get(env.SFU_ROOM.idFromName(room))
  const response = await stub.fetch("https://room/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "bot-status" }),
  })
  if (!response.ok) return null
  const status = (await response.json()) as {
    botEnabled?: boolean
    createdAt?: number
  }
  if (typeof status.createdAt !== "number") return null
  return { botEnabled: status.botEnabled === true, createdAt: status.createdAt }
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
  if (!isDev && !isAllowedOrigin(origin ?? null)) {
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

    const roomName = room.trim()
    const sfuRoom = await getSfuRoomStatus(roomName, cfEnv)
    if (!sfuRoom) return res.status(404).json({ error: "room not found" })
    if (Date.now() - sfuRoom.createdAt > ROOM_MAX_AGE_MS) {
      return res.status(410).json({ error: "room expired" })
    }
    if (!sfuRoom.botEnabled) {
      return res
        .status(403)
        .json({ error: "AI assistant not enabled for this room" })
    }

    const id = cfEnv.BOT_SESSION.idFromName(
      `sfu:${roomName}:${sfuRoom.createdAt}`
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
