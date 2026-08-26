import type { PendingMediaCleanup } from "../room/types"

export interface RealtimeEnv {
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
}

// Enforced by refusing *new* Agent media work once at capacity (see
// pendingCleanupHasCapacity, checked by RoomSession before admitting new
// subscriptions/grants) — never by silently evicting an unresolved entry.
// A room realistically has at most a handful of note-taker reassignments/
// failures in flight at once; these only matter if Cloudflare stays
// unreachable for an extended period.
export const MAX_PENDING_CLEANUP_ENTRIES = 16
export const MAX_PENDING_CLEANUP_MIDS_PER_ENTRY = 64

function getRealtimeCredentials(
  env: RealtimeEnv,
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
// result; queue them with queuePendingCleanup() and retry instead. This is
// fail-closed by design: the room-visible grant may still be revoked
// immediately regardless of this result, since the actual per-request
// security boundary is the independent grant re-check on every subsequent
// Agent media request (RoomSession's "authorize" action) — this function is
// only responsible for actually stopping already-flowing RTP, on a
// best-effort/retry basis.
//
// IMPORTANT (Durable Object concurrency): this performs real network I/O.
// Cloudflare Durable Objects can interleave handling of another incoming
// request while a request is awaiting non-storage I/O like fetch() — so a
// caller must never hold an in-memory RoomRecord mutated *before* this call
// and save it *after* this call resolves, since a concurrent request could
// have persisted newer state in between. Always persist any mutation before
// calling this, and re-read fresh state afterward before merging the result
// — see RoomSession's attemptCleanupNow/stageAgentMediaRevocation split.
export async function closeRealtimeTracks(
  env: RealtimeEnv,
  sessionId: string,
  mids: string[],
): Promise<boolean> {
  if (mids.length === 0) return true
  const credentials = getRealtimeCredentials(env)
  if (!credentials) return false
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(
        credentials.appId,
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
      },
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
// for a sessionId into the pending-cleanup queue. Purely additive — never
// evicts or truncates an existing, still-unresolved entry to stay under a
// bound (see MAX_PENDING_CLEANUP_ENTRIES/MAX_PENDING_CLEANUP_MIDS_PER_ENTRY
// and pendingCleanupHasCapacity: the bound is enforced by *refusing new
// Agent media work* at the admission call sites, checked separately and
// *before* calling this — never by dropping data already queued here).
export function queuePendingCleanup(
  existing: PendingMediaCleanup[],
  sessionId: string,
  mids: string[],
): PendingMediaCleanup[] {
  if (mids.length === 0) return existing
  const matchIndex = existing.findIndex(
    (entry) => entry.sessionId === sessionId,
  )
  if (matchIndex < 0) {
    return [...existing, { sessionId, mids: [...new Set(mids)] }]
  }
  const merged = [...new Set([...existing[matchIndex].mids, ...mids])]
  const next = existing.slice()
  next[matchIndex] = { sessionId, mids: merged }
  return next
}

// Whether a *new* pending-cleanup entry (or additional mids on an existing
// one) can be admitted without exceeding the bound. Checked by RoomSession
// *before* admitting new Agent media work (a new grant, a new subscribed
// mid) — the bound is enforced here, as a refusal, never as eviction inside
// queuePendingCleanup itself.
export function pendingCleanupHasCapacity(
  entries: PendingMediaCleanup[],
  sessionId: string,
  additionalMidCount = 0,
): boolean {
  const existing = entries.find((entry) => entry.sessionId === sessionId)
  if (existing) {
    return (
      existing.mids.length + additionalMidCount <=
      MAX_PENDING_CLEANUP_MIDS_PER_ENTRY
    )
  }
  return entries.length < MAX_PENDING_CLEANUP_ENTRIES
}

// Pure decision logic: removes exactly the mids that were just *confirmed*
// closed from the given entries — never the whole matching entry outright,
// since a concurrent request could have queued additional mids for the same
// sessionId while the close attempt was in flight (Durable Object
// interleaving — see closeRealtimeTracks's own comment). An entry that
// still has mids left over after the removal is kept; one that's now empty
// is dropped. This is the "merge only the cleanup result" half of the
// fetch-then-reload-then-narrow-merge pattern RoomSession uses everywhere
// it calls closeRealtimeTracks.
export function removeConfirmedMids(
  entries: PendingMediaCleanup[],
  confirmed: PendingMediaCleanup[],
): PendingMediaCleanup[] {
  let result = entries
  for (const { sessionId, mids } of confirmed) {
    const confirmedSet = new Set(mids)
    result = result
      .map((entry) =>
        entry.sessionId === sessionId
          ? {
              sessionId,
              mids: entry.mids.filter((mid) => !confirmedSet.has(mid)),
            }
          : entry,
      )
      .filter((entry) => entry.mids.length > 0)
  }
  return result
}
