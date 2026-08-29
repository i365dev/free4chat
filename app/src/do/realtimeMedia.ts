import type {
  PendingMediaCleanup,
  RoomMediaState,
  RoomParticipant,
} from "../room/types"

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
  mids: string[]
): Promise<boolean> {
  if (mids.length === 0) return true
  const credentials = getRealtimeCredentials(env)
  if (!credentials) return false
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(
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
// for a sessionId into the pending-cleanup queue. Purely additive — never
// evicts or truncates an existing, still-unresolved entry to stay under a
// bound (see MAX_PENDING_CLEANUP_ENTRIES/MAX_PENDING_CLEANUP_MIDS_PER_ENTRY
// and pendingCleanupHasCapacity: the bound is enforced by *refusing new
// Agent media work* at the admission call sites, checked separately and
// *before* calling this — never by dropping data already queued here).
export function queuePendingCleanup(
  existing: PendingMediaCleanup[],
  sessionId: string,
  mids: string[]
): PendingMediaCleanup[] {
  if (mids.length === 0) return existing
  const matchIndex = existing.findIndex(
    (entry) => entry.sessionId === sessionId
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
  additionalMidCount = 0
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
  confirmed: PendingMediaCleanup[]
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
          : entry
      )
      .filter((entry) => entry.mids.length > 0)
  }
  return result
}

// Pure decision logic (#83 review): whether an Agent's exact-track subscribe
// target is admissible. An Agent holding a Meeting Notes grant may subscribe
// ONLY to a HUMAN participant's AUDIO track — never Human video (screen
// share) and never another Agent's published voice track, even when it
// knows both identifiers. Matching against ROOM state (not client claims)
// closes the spoofed-kind hole; unknown targets fail identically so the
// check leaks no existence oracle either way.
export function isHumanAudioTrackTarget(
  participants: Record<string, RoomParticipant>,
  trackSessionId: string,
  trackName: string
): boolean {
  return Object.values(participants).some(
    (candidate) =>
      candidate.kind === "human" &&
      candidate.media?.sessionId === trackSessionId &&
      candidate.media.tracks.some(
        (track) => track.trackName === trackName && track.kind === "audio"
      )
  )
}

// Which Agent media directions a revocation trigger covers (#83 review).
// The Meeting Notes grant independently authorizes Human→Agent *subscribe*
// media on the agent's session (tracked as agentSubscribedMids); the
// Agent Voice grant independently authorizes Agent→Human *published* media
// (agentPublishedMid plus its room-visible audio track entry). Stopping or
// reassigning ONE grant must never tear down the OTHER grant's
// still-active media — so every trigger stages exactly its own direction:
//
// - "subscribed": meeting-notes-stop / note-taker reassignment only.
// - "published": disabling Agent Voice / speaker reassignment only.
// - "both": participant leave, lease-expiry sweep, and full media-session
//   rotation (S1→S2), which tear down everything by definition.
export type AgentMediaRevocationDirection = "subscribed" | "published" | "both"

// Steps 1-2 of the revocation sequence (round 4), now direction-aware:
// SYNCHRONOUS, no I/O. Moves an agent's tracked mids for the requested
// direction out of its participant record and into room.pendingMediaCleanup,
// in memory only — the caller is responsible for persisting `room`
// (saveRoom/scheduleNextAlarm/broadcastState) *before* ever attempting the
// actual Cloudflare close (see attemptCleanupNow). This split exists
// specifically so a Cloudflare fetch() is never awaited while an in-memory
// RoomRecord sits unsaved: Durable Objects can interleave handling of
// another incoming request during that await, and a stale RoomRecord saved
// afterward would silently clobber whatever that other request persisted in
// the meantime. Never truncates tracked mids or evicts an existing
// pendingMediaCleanup entry — queuePendingCleanup is purely additive; the
// bound is enforced elsewhere by refusing *new* Agent media work (see
// pendingCleanupHasCapacity), not by dropping data here. No-ops cheaply
// when there is nothing to move in the requested direction (ordinary
// text-only agents, an agent granted but never subscribed, a Meeting Notes
// stop for an agent with no voiceReply publication, etc.).
export function stageAgentMediaRevocation(
  participant: RoomParticipant | undefined,
  pendingMediaCleanup: PendingMediaCleanup[],
  direction: AgentMediaRevocationDirection = "both"
): PendingMediaCleanup[] {
  if (!participant || participant.kind !== "agent" || !participant.media)
    return pendingMediaCleanup
  const media = participant.media
  const mids = direction === "published" ? [] : media.agentSubscribedMids ?? []
  const publishedMid =
    direction === "subscribed" ? undefined : media.agentPublishedMid
  if (mids.length === 0 && !publishedMid) return pendingMediaCleanup

  const nextMedia: RoomMediaState = { ...media }
  // Subscribe revocation clears only the Human→Agent ingress mids; an
  // active voiceReply publication belongs to the independent voiceReply
  // grant and must survive a Meeting Notes stop/reassignment untouched.
  if (direction !== "published") nextMedia.agentSubscribedMids = []
  // Publish revocation closes only the Agent→Human published mid AND drops
  // the room-visible Agent voice track so broadcasts stop advertising it
  // (an Agent's tracks array can only ever contain its voice publication —
  // the ordinary "publish" action rejects agents outright); active Meeting
  // Notes subscriptions must survive it.
  if (direction !== "subscribed") {
    nextMedia.agentPublishedMid = undefined
    nextMedia.agentPublishedTrackName = undefined
    nextMedia.tracks = nextMedia.tracks.filter(
      (track) => track.kind !== "audio"
    )
  }
  participant.media = nextMedia
  return queuePendingCleanup(
    pendingMediaCleanup,
    media.sessionId,
    publishedMid && !mids.includes(publishedMid)
      ? [...mids, publishedMid]
      : mids
  )
}
