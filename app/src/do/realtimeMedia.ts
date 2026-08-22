import type { PendingMediaCleanup } from "../room/types"

export interface RealtimeEnv {
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
}

// Bounds the pending-cleanup queue itself (not a general media-session
// database — see queuePendingCleanup): a room realistically has at most a
// handful of note-taker reassignments/failures in flight at once, this only
// guards against pathological growth if Cloudflare stays unreachable.
const MAX_PENDING_CLEANUP_ENTRIES = 16
const MAX_PENDING_CLEANUP_MIDS = 64

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
// Returns whether the close was *confirmed* — a non-2xx response, a missing
// SFU credential, or a network failure are all treated as "not confirmed",
// never as a silent success. Callers must not discard `mids` on a `false`
// result; queue them with queuePendingCleanup() and retry instead — see
// RoomSession's closeAgentMediaTracks/retryPendingMediaCleanup. This is
// fail-closed by design: the room-visible grant may still be revoked
// immediately regardless of this result (see RoomSession's meeting-notes-
// stop/-start handlers), since the actual per-request security boundary is
// the independent grant re-check on every subsequent Agent media request
// (RoomSession's "authorize" action) — this function is only responsible
// for actually stopping already-flowing RTP, on a best-effort/retry basis.
export async function closeRealtimeTracks(
  env: RealtimeEnv,
  sessionId: string,
  mids: string[]
): Promise<boolean> {
  if (mids.length === 0) return true
  const credentials = getRealtimeCredentials(env)
  if (!credentials) return false
  try {
    const response = await fetch(
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
    // Deliberately never reads/logs the response body — it's Cloudflare's
    // upstream API response and may carry details not meant for our logs.
    return response.ok
  } catch {
    return false
  }
}

// Pure decision logic (directly unit-testable, unlike RoomSession itself —
// see roomExpiry.ts/meetingNotesAuth.ts for why): merges newly-failed mids
// for a sessionId into the bounded pending-cleanup queue, so a failed
// closeRealtimeTracks() call is retried rather than forgotten. Not a
// general media-session database: entries only ever hold mids still
// awaiting a *confirmed* Cloudflare close, and both bounds below keep this
// small regardless of how many revocations pile up while Cloudflare is
// unreachable.
export function queuePendingCleanup(
  existing: PendingMediaCleanup[],
  sessionId: string,
  mids: string[]
): PendingMediaCleanup[] {
  if (mids.length === 0) return existing
  const merged = existing.map((entry) =>
    entry.sessionId === sessionId
      ? {
          sessionId,
          mids: [...new Set([...entry.mids, ...mids])].slice(
            -MAX_PENDING_CLEANUP_MIDS
          ),
        }
      : entry
  )
  if (merged.some((entry) => entry.sessionId === sessionId)) return merged
  return [
    ...merged,
    { sessionId, mids: mids.slice(-MAX_PENDING_CLEANUP_MIDS) },
  ].slice(-MAX_PENDING_CLEANUP_ENTRIES)
}

// Pure decision logic: given the outcome of retrying each pending entry,
// returns the entries that still need another retry (a confirmed-closed
// entry is dropped for good; everything else is retained verbatim).
export function applyCleanupResults(
  entries: PendingMediaCleanup[],
  succeeded: (entry: PendingMediaCleanup) => boolean
): PendingMediaCleanup[] {
  return entries.filter((entry) => !succeeded(entry))
}
