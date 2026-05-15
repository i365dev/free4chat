interface Env {
  ROOMS_KV: KVNamespace
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  RTK_APP_ID: string
  RTK_PRESET_NAME: string
  ALLOWED_ORIGIN: string
}

const rtkBase = (env: Env) =>
  `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}`

const authHeaders = (env: Env) => ({
  Authorization: `Bearer ${env.CF_API_TOKEN}`,
  "Content-Type": "application/json",
})

async function getOrCreateMeeting(roomName: string, env: Env): Promise<string> {
  const cached = await env.ROOMS_KV.get(`room:${roomName}`)
  if (cached) return cached

  const res = await fetch(`${rtkBase(env)}/meetings`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ title: roomName }),
  })
  const data = await res.json()
  console.log("[getOrCreateMeeting] response:", JSON.stringify(data))
  const meetingId = (data as any).data.id

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
    body: JSON.stringify({ name, preset_name: presetName, custom_participant_id: crypto.randomUUID() }),
  })
  const data = await res.json()
  console.log("[addParticipant] response:", JSON.stringify(data))
  return (data as any).data.token
}

function corsHeaders(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) })
    }

    const url = new URL(request.url)

    if (url.pathname === "/api/token" && request.method === "POST") {
      try {
        const { room, name } = (await request.json()) as { room: string; name: string }
        if (!room || !name) {
          return Response.json(
            { error: "room and name required" },
            { status: 400, headers: corsHeaders(env) }
          )
        }

        const meetingId = await getOrCreateMeeting(room, env)
        const authToken = await addParticipant(meetingId, name, env)

        return Response.json({ authToken }, { headers: corsHeaders(env) })
      } catch (err) {
        console.error(err)
        return Response.json(
          { error: "internal error" },
          { status: 500, headers: corsHeaders(env) }
        )
      }
    }

    return new Response("Not Found", { status: 404 })
  },
}
