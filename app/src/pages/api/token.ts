import type { NextApiRequest, NextApiResponse } from "next"
import { getCloudflareContext } from "@opennextjs/cloudflare"

interface Env {
  ROOMS_KV: KVNamespace
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  RTK_APP_ID: string
  RTK_PRESET_NAME: string
}

function rtkBase(env: Env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}`
}

function authHeaders(env: Env) {
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  }
}

async function getOrCreateMeeting(roomName: string, env: Env): Promise<string> {
  const cached = await env.ROOMS_KV.get(`room:${roomName}`)
  if (cached) return cached

  const res = await fetch(`${rtkBase(env)}/meetings`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ title: roomName }),
  })
  const data = (await res.json()) as any
  const meetingId = data.data.id

  await env.ROOMS_KV.put(`room:${roomName}`, meetingId, {
    expirationTtl: 30 * 24 * 3600,
  })
  return meetingId
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

  try {
    const { env } = getCloudflareContext()
    const cfEnv = env as unknown as Env

    const { room, name } = req.body as { room: string; name: string }
    if (!room || !name) {
      return res.status(400).json({ error: "room and name required" })
    }

    const meetingId = await getOrCreateMeeting(room, cfEnv)
    const authToken = await addParticipant(meetingId, name, cfEnv)

    return res.status(200).json({ authToken })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: "internal error" })
  }
}
