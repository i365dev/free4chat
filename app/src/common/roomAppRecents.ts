/**
 * #98: bounded, Room-scoped recency for the in-Room App launcher.
 *
 * The inline Stage strip is progressive disclosure, not a catalog: it shows the
 * current App plus a very small set of Apps this browser actually opened in
 * THIS Room. Recency therefore stays a generic, host-owned signal — no
 * accounts, no favorites, no cross-device preferences, no per-App ranking.
 *
 * Recency lives in `sessionStorage` (per tab, cleared when the tab closes) and
 * is namespaced per Room name, so a second Room in the same tab starts clean.
 * Nothing is ever written to `localStorage`; there is no server-side state.
 */

/**
 * How many recent Apps stay inline on a wide Stage strip. Deliberately tiny:
 * the launcher, not the strip, is the growing surface.
 */
export const ROOM_APP_INLINE_RECENT_MAX = 2

/** How many recent Apps the launcher remembers (and may show). */
export const ROOM_APP_RECENT_MAX = 6

/**
 * A wide Stage strip can afford exactly one more shortcut than a phone: three
 * chips including the current App. The launcher, not the strip, is what grows
 * with the catalog, so both bounds are hard product limits rather than CSS
 * accidents.
 */
export const ROOM_APP_INLINE_RECENT_MAX_DESKTOP = 3

const RECENTS_STORAGE_PREFIX = "free4chat:room-app-recents:v1:"

function recentsStorageKey(roomName: string): string {
  return `${RECENTS_STORAGE_PREFIX}${roomName}`
}

/**
 * Move `appId` to the front of the bounded recency list. Opening an App that is
 * already recent only reorders it — duplicates never accumulate.
 */
export function pushRecentRoomAppId(
  recents: readonly string[],
  appId: string,
  max = ROOM_APP_RECENT_MAX
): string[] {
  if (appId.length === 0 || max <= 0) return recents.slice(0, Math.max(0, max))
  return [appId, ...recents.filter((id) => id !== appId)].slice(0, max)
}

/**
 * Keep only Apps the current catalog still offers, in the order remembered.
 * A removed (or renamed) App id silently drops out of recency.
 */
export function pruneRecentRoomAppIds(
  recents: readonly string[],
  availableAppIds: ReadonlySet<string>,
  max = ROOM_APP_RECENT_MAX
): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of recents) {
    if (!availableAppIds.has(id) || seen.has(id)) continue
    seen.add(id)
    next.push(id)
    if (next.length >= max) break
  }
  return next
}

/** Read this browser tab's remembered App order for one Room. */
export function readRecentRoomAppIds(roomName: string): string[] {
  if (typeof window === "undefined" || roomName.length === 0) return []
  try {
    const raw = window.sessionStorage.getItem(recentsStorageKey(roomName))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids: string[] = []
    for (const value of parsed) {
      if (typeof value !== "string" || value.length === 0) continue
      if (ids.includes(value)) continue
      ids.push(value)
      if (ids.length >= ROOM_APP_RECENT_MAX) break
    }
    return ids
  } catch {
    // Storage can be unavailable (private mode, disabled cookies). Recency is
    // an enhancement; the inline strip must still work without it.
    return []
  }
}

/** Persist this browser tab's App order for one Room. Never throws. */
export function writeRecentRoomAppIds(
  roomName: string,
  recents: readonly string[]
): void {
  if (typeof window === "undefined" || roomName.length === 0) return
  try {
    if (recents.length === 0) {
      window.sessionStorage.removeItem(recentsStorageKey(roomName))
      return
    }
    window.sessionStorage.setItem(
      recentsStorageKey(roomName),
      JSON.stringify(recents.slice(0, ROOM_APP_RECENT_MAX))
    )
  } catch {
    // A failed write only costs recency after a reload.
  }
}

/**
 * The Apps shown inline: the current App always wins the first slot, then the
 * most recent others — capped, de-duplicated, catalog-order-independent.
 */
export function inlineRoomAppIds(
  recents: readonly string[],
  activeAppId: string | null | undefined,
  availableAppIds: ReadonlySet<string>,
  max = ROOM_APP_INLINE_RECENT_MAX
): string[] {
  if (max <= 0) return []
  const ordered: string[] = []
  if (activeAppId && availableAppIds.has(activeAppId)) ordered.push(activeAppId)
  for (const id of recents) if (availableAppIds.has(id)) ordered.push(id)
  const seen = new Set<string>()
  const inline: string[] = []
  for (const id of ordered) {
    if (seen.has(id)) continue
    seen.add(id)
    inline.push(id)
    if (inline.length >= max) break
  }
  return inline
}
