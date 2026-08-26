// Rooms no longer have a fixed total lifetime — Cloudflare Realtime SFU is
// billed by usage, not connection duration, so an actively-occupied room can
// stay open indefinitely. Instead, a room is cleaned up only after it has
// held zero participants (human or agent) for this long, which bounds how
// long an abandoned room's Durable Object storage lingers.
export const EMPTY_ROOM_TIMEOUT_MS = 30 * 60 * 1000

// A fixed, comparable sentinel meaning "no pending expiry" — used instead of
// a moving `now + horizon` value so a later call can tell whether a deadline
// was already set for the *current* empty streak (and must not be pushed
// further out) versus never set at all.
export const NO_EXPIRY = Date.UTC(2100, 0, 1)

/**
 * Recomputes a room's expiresAt from its participant count. Must be called
 * after every mutation that adds or removes a participant.
 *
 * - A room with at least one participant never expires (NO_EXPIRY).
 * - A room that just became empty gets a fresh EMPTY_ROOM_TIMEOUT_MS
 *   deadline.
 * - A room that was already empty keeps its existing deadline, so calling
 *   this repeatedly while empty can't push cleanup out indefinitely.
 */
export function computeExpiresAt(
  participantCount: number,
  currentExpiresAt: number,
  now: number
): number {
  if (participantCount > 0) return NO_EXPIRY
  if (currentExpiresAt === NO_EXPIRY) return now + EMPTY_ROOM_TIMEOUT_MS
  return currentExpiresAt
}
