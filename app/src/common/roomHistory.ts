/**
 * #346: same-browser repeat-use direction.
 *
 * Free4Chat deliberately has no durable user identity, and this module does
 * not add one. It reads the browser-local Room history that already exists
 * (the Rooms this browser chose to remember, written by
 * `saveRoomToLocalStorage` into the `rooms` key) and reduces it to two COARSE
 * properties on an already-meaningful Room-scoped event.
 *
 * It is directional evidence about this browser only:
 *
 *   - not account retention;
 *   - not unique-user retention;
 *   - not cross-device;
 *   - not D7/D30.
 *
 * Nothing here is ever sent: only the bucket and the boolean leave the
 * browser. Room names, nicknames, and counts stay local.
 *
 * ## What counts as "prior use"
 *
 * The whole question is `how much prior Room use did this same browser have
 * BEFORE this meaningful activation?`, and the only thing that must never be
 * counted is the CURRENT page load's own history write.
 *
 * Excluding the current Room *by name* would be wrong: the history is already
 * deduplicated by name, so a browser that used `room-a` last week and opens
 * `room-a` again — even though that name now names a brand-new Room
 * generation — would be scored as having no prior use at all, systematically
 * erasing same-name reuse.
 *
 * So the boundary is the PAGE LOAD, not the name: the history is snapshotted
 * (see `preVisitRoomNames`) before this page load writes anything, and every
 * Room remembered at that instant is prior use. A Room that only appears in
 * history because this launch just wrote it is therefore not counted, while a
 * Room that was genuinely already there — same name or not — is.
 */

/** The existing browser-local Room history key (see utils.saveRoomToLocalStorage). */
export const ROOM_HISTORY_STORAGE_KEY = "rooms"

/**
 * `How much prior Room use did this same browser have before this meaningful
 * activation?` — bucketed, never the raw integer.
 *
 *   0    no prior Room in this browser
 *   1    exactly one prior Room
 *   2-5  two to five prior Rooms
 *   6+   six or more prior Rooms
 */
export type PriorRoomCountBucket = "0" | "1" | "2-5" | "6+"

export function priorRoomCountBucket(count: number): PriorRoomCountBucket {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count === 1) return "1"
  if (count <= 5) return "2-5"
  return "6+"
}

export interface BrowserRepeatUse {
  returningBrowser: boolean
  priorRoomCountBucket: PriorRoomCountBucket
}

/**
 * The browser's Room history as it was BEFORE this page load wrote anything.
 *
 * Frozen on first touch by the deliberate page-load boundary: every writer
 * calls `noteRoomHistoryWrite()` first (see utils.saveRoomToLocalStorage), and
 * a read that happens first freezes the same pre-write state, so the snapshot
 * can never contain this page load's own entry no matter which happens first.
 *
 * In-memory only: nothing new is persisted, and nothing identifies the
 * browser, tab, or person. The consequence is that a full reload starts a new
 * boundary, so reloading a Room that this browser remembered before the
 * reload reads as prior use — a truthful statement about the browser, and one
 * that requires an explicit user action to reach.
 */
let preVisitRoomNames: readonly string[] | null = null

function preVisitHistory(): readonly string[] {
  if (preVisitRoomNames === null) preVisitRoomNames = readStoredRoomNames()
  return preVisitRoomNames
}

/**
 * The page-load boundary. MUST be called before the history is written, so
 * the current launch's own entry can never be counted as prior use.
 */
export function noteRoomHistoryWrite(): void {
  preVisitHistory()
}

/**
 * Reduce the pre-visit history to the coarse repeat-use properties. Any
 * storage failure (private mode, disabled storage, malformed or foreign
 * value) degrades to the same truthful "no prior Rooms" answer instead of
 * breaking the product flow.
 *
 * The current Room is NOT excluded by name: if it was already remembered
 * before this page load, it is genuine prior use.
 */
export function browserRepeatUse(): BrowserRepeatUse {
  const count = preVisitHistory().length
  return {
    returningBrowser: count > 0,
    priorRoomCountBucket: priorRoomCountBucket(count),
  }
}

/**
 * Distinct remembered Room names. The writer deduplicates by name, but a
 * malformed or foreign value must not be able to inflate the count.
 */
function readStoredRoomNames(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(ROOM_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const names = parsed
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { roomName?: unknown }).roomName
          : undefined
      )
      .filter((name): name is string => typeof name === "string")
    return [...new Set(names)]
  } catch {
    return []
  }
}
