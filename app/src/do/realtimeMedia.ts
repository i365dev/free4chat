export interface RealtimeEnv {
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
}

function getRealtimeCredentials(
  env: RealtimeEnv
): { appId: string; appSecret: string } | null {
  const appId = env.SFU_APP_ID
  const appSecret = env.SFU_APP_SECRET
  return appId && appSecret ? { appId, appSecret } : null
}

// The real server-side revocation boundary for Meeting Notes (#82): mutating
// room state alone does not stop RTP already flowing over an established
// PeerConnection — only actively closing the upstream Cloudflare Realtime
// tracks does. `force: true` because this is a server-initiated close, not
// one coordinated with the subscribing Agent's own SDP renegotiation (the
// Agent may be slow, unresponsive, or gone entirely — revocation must not
// depend on its cooperation).
//
// Best-effort by design: a failed close here must never block the
// room-state mutation that triggered it (Stop/reassignment/leave/expiry all
// still need to succeed). The actual security boundary is that every
// subsequent Agent media request is independently re-checked against the
// current grant (see RoomSession's "authorize" and "agent-room-media"
// actions) — this call is what stops already-flowing RTP, not what
// authorizes future requests.
export async function closeRealtimeTracks(
  env: RealtimeEnv,
  sessionId: string,
  mids: string[]
): Promise<void> {
  if (mids.length === 0) return
  const credentials = getRealtimeCredentials(env)
  if (!credentials) return
  await fetch(
    `https://rtc.live.cloudflare.com/apps/${encodeURIComponent(
      credentials.appId
    )}/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${credentials.appSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tracks: mids.map((mid) => ({ mid })),
        force: true,
      }),
    }
  )
}
