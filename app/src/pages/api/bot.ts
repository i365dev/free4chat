import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { NextApiRequest, NextApiResponse } from "next"

interface Env {
  ROOMS_KV: KVNamespace
  BOT_SESSION: DurableObjectNamespace
  TURNSTILE_SECRET_KEY?: string
}

const ALLOWED_ORIGINS = [
  "https://free4.chat",
  "https://www.free4.chat",
  "https://free4chat.i365.workers.dev",
]

const RATE_LIMIT_WINDOW_S = 3600
const RATE_LIMIT_MAX = 30

async function verifyTurnstile(
  token: string,
  secretKey: string,
  ip: string
): Promise<boolean> {
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
        remoteip: ip,
      }),
    }
  )
  const data = (await res.json()) as { success: boolean }
  return data.success === true
}

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

    const { room, userMessage, userName, turnstileToken } = req.body as {
      room: string
      userMessage: string
      userName: string
      turnstileToken?: string
    }

    if (!room || !userMessage || !userName) {
      return res
        .status(400)
        .json({ error: "room, userMessage, userName required" })
    }

    if (!isDev && cfEnv.TURNSTILE_SECRET_KEY && turnstileToken) {
      const valid = await verifyTurnstile(
        turnstileToken,
        cfEnv.TURNSTILE_SECRET_KEY,
        ip
      )
      if (!valid) {
        return res.status(403).json({ error: "Turnstile verification failed" })
      }
    }

    const id = cfEnv.BOT_SESSION.idFromName(room)
    const stub = cfEnv.BOT_SESSION.get(id)
    const doRes = await stub.fetch("https://bot/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage, userName }),
    })

    const data = (await doRes.json()) as { reply?: string; error?: string }
    if (!doRes.ok || data.error) {
      if (data.error === "rate_limited") {
        return res
          .status(429)
          .json({ error: "Luna has reached her hourly reply limit." })
      }
      return res.status(500).json({ error: "ai_error" })
    }

    return res.status(200).json({ reply: data.reply })
  } catch (err) {
    console.error("[/api/bot]", err)
    return res.status(500).json({ error: "internal error" })
  }
}
