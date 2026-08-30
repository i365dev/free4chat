import type { PendingMediaCleanup } from "../room/types"

// The external Cloudflare Realtime effect boundary. This module intentionally
// knows only exact session/mid resources — never Room grants, participants,
// or other authoritative Room state. RoomSession decides and persists those
// first, then snapshots effects here, performs I/O, reloads fresh state, and
// passes only the current pending-cleanup queue back for narrow reconciliation.

export interface RealtimeEnv {
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
}

export interface MediaCloseEffect {
  sessionId: string
  mids: string[]
}

export interface MediaCloseResult {
  effect: MediaCloseEffect
  confirmedMids: string[]
}

function getRealtimeCredentials(
  env: RealtimeEnv
): { appId: string; appSecret: string } | null {
  const appId = env.SFU_APP_ID
  const appSecret = env.SFU_APP_SECRET
  return appId && appSecret ? { appId, appSecret } : null
}

function exactEffect(effect: MediaCloseEffect): MediaCloseEffect {
  return {
    sessionId: effect.sessionId,
    mids: [...effect.mids],
  }
}

/**
 * Captures the exact resources that are eligible for this close attempt.
 * Later Room mutations must not change this snapshot, and reconciliation can
 * therefore only remove mids that this particular effect confirmed.
 */
export function snapshotMediaCloseEffects(
  entries: PendingMediaCleanup[]
): MediaCloseEffect[] {
  return entries
    .map((entry) => exactEffect(entry))
    .filter((effect) => effect.mids.length > 0)
}

/**
 * Performs one server-initiated tracks/close call. Cloudflare exposes the
 * result as a single HTTP status rather than per-track confirmations, so a
 * 2xx confirms every requested mid and every other outcome confirms none.
 * The result still models a subset so fresh-state reconciliation remains
 * correct if a future effect source has partial confirmation.
 */
export async function executeMediaCloseEffect(
  env: RealtimeEnv,
  effect: MediaCloseEffect
): Promise<MediaCloseResult> {
  const exact = exactEffect(effect)
  if (exact.mids.length === 0) return { effect: exact, confirmedMids: [] }
  const credentials = getRealtimeCredentials(env)
  if (!credentials) return { effect: exact, confirmedMids: [] }
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(
        credentials.appId
      )}/sessions/${encodeURIComponent(exact.sessionId)}/tracks/close`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${credentials.appSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tracks: exact.mids.map((mid) => ({ mid })),
          force: true,
        }),
      }
    )
    // Never read or log Cloudflare's response body. It can contain upstream
    // details, and the only authoritative cleanup signal here is 2xx.
    return {
      effect: exact,
      confirmedMids: response.ok ? exact.mids : [],
    }
  } catch {
    return { effect: exact, confirmedMids: [] }
  }
}

/** Executes a read-only effect snapshot; it never mutates Room state. */
export async function executeMediaCloseEffects(
  env: RealtimeEnv,
  effects: MediaCloseEffect[]
): Promise<MediaCloseResult[]> {
  const results: MediaCloseResult[] = []
  for (const effect of effects)
    results.push(await executeMediaCloseEffect(env, effect))
  return results
}

function confirmedMidsForEffect(result: MediaCloseResult): string[] {
  const requested = new Set(result.effect.mids)
  return [...new Set(result.confirmedMids.filter((mid) => requested.has(mid)))]
}

/**
 * Pure fresh-state reconciliation. Call this only with a Room's freshly
 * loaded pending queue after external I/O. It removes confirmed mids from the
 * matching session only, retaining failures, partials, and cleanup that was
 * added while the effect was in flight.
 */
export function reconcileMediaCloseResults(
  entries: PendingMediaCleanup[],
  results: MediaCloseResult[]
): PendingMediaCleanup[] {
  let reconciled = entries
  for (const result of results) {
    const confirmedMids = confirmedMidsForEffect(result)
    if (confirmedMids.length === 0) continue
    const confirmed = new Set(confirmedMids)
    reconciled = reconciled
      .map((entry) =>
        entry.sessionId === result.effect.sessionId
          ? {
              sessionId: entry.sessionId,
              mids: entry.mids.filter((mid) => !confirmed.has(mid)),
            }
          : entry
      )
      .filter((entry) => entry.mids.length > 0)
  }
  return reconciled
}

/**
 * The Worker owns compensation for a just-created Agent resource that the DO
 * subsequently rejected during post-create registration. Close the exact
 * resource; if confirmation is absent, hand off only the unresolved mids to
 * RoomSession, whose cleanup queue is the durable retry authority.
 */
export async function compensateUnacceptedAgentMedia(
  env: RealtimeEnv,
  effect: MediaCloseEffect,
  handoffUnresolved: (effect: MediaCloseEffect) => Promise<void>
): Promise<MediaCloseResult> {
  const result = await executeMediaCloseEffect(env, effect)
  const confirmed = new Set(confirmedMidsForEffect(result))
  const unresolved = result.effect.mids.filter((mid) => !confirmed.has(mid))
  if (unresolved.length > 0)
    await handoffUnresolved({
      sessionId: result.effect.sessionId,
      mids: unresolved,
    })
  return result
}
