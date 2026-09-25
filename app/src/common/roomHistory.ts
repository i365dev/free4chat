/**
 * #346: same-browser repeat-use direction.
 *
 * Free4Chat deliberately has no durable user identity, and this module does
 * not add one. It reads the browser-local Room history that already exists
 * (the visits this browser chose to remember, written by
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

/**
 * Prior Room count for the CURRENT Room name, excluding the current Room
 * itself.
 *
 * The existing helper stores at most one entry per Room name, and the
 * current Room is normally written BEFORE this is read (the join flow saves
 * it on nickname confirmation, while RoomActivated only fires once the Room
 * is already meaningfully connected). Subtracting the current entry when it
 * is present is what keeps that off-by-one out: the current Room is never
 * counted as prior use, and a browser where it has not been written yet is
 * counted identically.
 */
export function priorRoomCount(
  storedRoomNames: readonly string[],
  currentRoomName: string
): number {
  const others = storedRoomNames.filter((name) => name !== currentRoomName)
  return others.length
}

export interface BrowserRepeatUse {
  returningBrowser: boolean
  priorRoomCountBucket: PriorRoomCountBucket
}

/**
 * Read the browser-local Room history and reduce it to the coarse repeat-use
 * properties. Any storage failure (private mode, disabled storage, malformed
 * or foreign value) degrades to the same truthful "no prior Rooms" answer
 * instead of breaking the product flow.
 */
export function browserRepeatUse(roomName: string): BrowserRepeatUse {
  const count = priorRoomCount(readStoredRoomNames(), roomName)
  return {
    returningBrowser: count > 0,
    priorRoomCountBucket: priorRoomCountBucket(count),
  }
}

function readStoredRoomNames(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(ROOM_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) =>
        entry && typeof entry === "object"
          ? (entry as { roomName?: unknown }).roomName
          : undefined
      )
      .filter((name): name is string => typeof name === "string")
  } catch {
    return []
  }
}
