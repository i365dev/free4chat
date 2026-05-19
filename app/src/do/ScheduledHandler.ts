interface Env {
  ROOMS_KV: KVNamespace
  CF_API_TOKEN: string
  CF_ACCOUNT_ID: string
  RTK_APP_ID: string
}

interface RoomRecord {
  meetingId: string
  createdAt: number
  roomType: "audio" | "screenshare"
  botEnabled?: boolean
}

const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000

function rtkBase(env: Env): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}`
}

function authHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  }
}

async function deactivateMeeting(meetingId: string, env: Env): Promise<void> {
  try {
    const res = await fetch(
      `${rtkBase(env)}/meetings/${meetingId}/participants`,
      {
        headers: authHeaders(env),
      }
    )
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id: string }> }
      const participants = body.data ?? []
      await Promise.all(
        participants.map((p) =>
          fetch(`${rtkBase(env)}/meetings/${meetingId}/participants/${p.id}`, {
            method: "DELETE",
            headers: authHeaders(env),
          })
            .then((r) => r.body?.cancel())
            .catch(() => {})
        )
      )
    } else {
      await res.body?.cancel()
    }
  } catch {}

  await fetch(`${rtkBase(env)}/meetings/${meetingId}`, {
    method: "PATCH",
    headers: authHeaders(env),
    body: JSON.stringify({ status: "INACTIVE" }),
  })
    .then((r) => r.body?.cancel())
    .catch(() => {})
}

async function cleanExpiredRooms(env: Env): Promise<void> {
  const now = Date.now()
  let cursor: string | undefined
  let cleaned = 0

  do {
    const page: KVNamespaceListResult<unknown, string> =
      await env.ROOMS_KV.list({
        prefix: "room:",
        ...(cursor ? { cursor } : {}),
      })

    for (const key of page.keys) {
      const raw = await env.ROOMS_KV.get(key.name)
      if (!raw) continue

      let record: RoomRecord
      try {
        record = JSON.parse(raw) as RoomRecord
      } catch {
        continue
      }

      if (now - record.createdAt > ROOM_MAX_AGE_MS) {
        await Promise.all([
          env.ROOMS_KV.delete(key.name),
          deactivateMeeting(record.meetingId, env),
        ])
        cleaned++
      }
    }

    cursor = page.list_complete ? undefined : (page as any).cursor
  } while (cursor)

  void cleaned
}

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(cleanExpiredRooms(env))
}
