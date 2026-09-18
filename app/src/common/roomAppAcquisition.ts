/**
 * #134 acquisition-context handoff, core side.
 *
 * The Lab discovery landing that acquired a launch is a bounded slug, not page
 * content. It must survive the `/open-app` → `/room` replace as analytics
 * context for *this browser tab's* Room session, and it must never become part
 * of the Room identity that an invite link can carry to someone else.
 *
 * So the handoff lives in `sessionStorage` (tab-local, per-origin, invisible to
 * the Room URL) and is bound to the exact launch identity it belongs to: the
 * generated Room name plus the launched App id. A later Room launch in the same
 * tab — a direct `/room` entry, or an invite link naming another Room — cannot
 * match that binding and therefore inherits nothing.
 *
 * This is one bounded fact with page-lifetime scope, not an attribution
 * profile: no user identity, no cross-Room state, no extra fields.
 */

const ACQUISITION_STORAGE_KEY = "free4chat:room-app-acquisition"

/** The same bounded discovery-slug contract the Lab registry already enforces. */
const ACQUISITION_PAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export interface RoomAppAcquisitionHandoff {
  roomName: string
  appId: string
  acquisitionPage: string
}

/** A query value is accepted only when it is exactly one bounded discovery slug. */
export function isValidAcquisitionPage(value: unknown): value is string {
  return typeof value === "string" && ACQUISITION_PAGE_PATTERN.test(value)
}

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    // Storage can be unavailable (disabled cookies, opaque origin). The launch
    // must still succeed; it simply carries no acquisition context.
    return null
  }
}

/**
 * Remember the acquisition intent for exactly one generated Room launch.
 * Returns the stored context so the caller can use the validated value
 * without re-reading or re-validating it.
 */
export function saveRoomAppAcquisition(input: {
  roomName: string
  appId: string
  acquisitionPage: string
}): RoomAppAcquisitionHandoff | null {
  if (
    !input.roomName ||
    !input.appId ||
    !isValidAcquisitionPage(input.acquisitionPage)
  )
    return null
  const handoff: RoomAppAcquisitionHandoff = {
    roomName: input.roomName,
    appId: input.appId,
    acquisitionPage: input.acquisitionPage,
  }
  const store = sessionStore()
  if (!store) return handoff
  try {
    // One pending acquisition per tab: a new launch replaces any older one
    // instead of leaving a second candidate behind.
    store.setItem(ACQUISITION_STORAGE_KEY, JSON.stringify(handoff))
  } catch {
    // A failed write must never block the launch.
  }
  return handoff
}

/**
 * Read the pending context, but only for the Room launch it was stored for.
 * Any mismatch, missing entry, or malformed payload returns null — a stale
 * entry is ignored rather than inherited or repaired.
 *
 * The bound Room is the launch identity that matters. `appId` is an optional
 * extra binding for a caller that holds the launching App; the Room page reads
 * by Room alone, so an App switch inside the acquired Room keeps the original
 * acquisition intent while still reporting the new App id on its events.
 */
export function readRoomAppAcquisition(
  roomName: string,
  appId?: string
): RoomAppAcquisitionHandoff | null {
  if (!roomName) return null
  const store = sessionStore()
  if (!store) return null
  let parsed: unknown
  try {
    const raw = store.getItem(ACQUISITION_STORAGE_KEY)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Partial<RoomAppAcquisitionHandoff>
  if (candidate.roomName !== roomName) return null
  if (appId !== undefined && candidate.appId !== appId) return null
  return isValidAcquisitionPage(candidate.acquisitionPage)
    ? {
        roomName: candidate.roomName,
        appId: candidate.appId as string,
        acquisitionPage: candidate.acquisitionPage,
      }
    : null
}

/** Drop the pending context. Called when the Room that consumed it unloads. */
export function clearRoomAppAcquisition(): void {
  const store = sessionStore()
  if (!store) return
  try {
    store.removeItem(ACQUISITION_STORAGE_KEY)
  } catch {
    // Nothing to recover: a leftover entry can only match its own Room again.
  }
}

/**
 * Attach the optional acquisition context to one Host-owned analytics payload.
 * The property is omitted entirely when no valid context exists, so existing
 * events keep their exact shape instead of gaining an `undefined` category.
 */
export function withAcquisitionPage<T extends Record<string, unknown>>(
  eventData: T,
  acquisitionPage: string | null
): T & { acquisitionPage?: string } {
  return isValidAcquisitionPage(acquisitionPage)
    ? { ...eventData, acquisitionPage }
    : eventData
}
