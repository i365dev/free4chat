import type { AgentImageMimeType, RoomSurfaceV1 } from "../room/types"

// #111 Observable Agent Workspace v0 policy. Deterministic and pure so the
// DO stays thin and every rule here is deterministically testable (same
// pattern as do/collab.ts).

export const MAX_SURFACE_BYTES = 768 * 1024
export const SURFACE_CHUNK_SIZE = 64 * 1024
export const MAX_ACTIVE_AGENT_SURFACES = 3
// Rapid replace throttle: a publisher may not update more often than this.
export const MIN_SURFACE_UPDATE_MS = 2000

const SURFACE_MIME_TYPES: readonly AgentImageMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
]

export function isSurfaceMimeType(value: unknown): value is AgentImageMimeType {
  return (
    typeof value === "string" &&
    SURFACE_MIME_TYPES.includes(value as AgentImageMimeType)
  )
}

export type SurfacePolicyResult =
  | { ok: true; chunkCount: number }
  | {
      ok: false
      error:
        | "surface_mime_unsupported"
        | "surface_empty"
        | "surface_too_large"
        | "surface_size_mismatch"
        | "surface_rate_limited"
        | "surface_capacity_exceeded"
    }

export interface SurfacePublishContext {
  mimeType: unknown
  /** Declared Content-Length, when the transport provided one. */
  declaredSize: number
  byteLength: number
  /** Number of OTHER agent participants currently holding a surface. */
  otherActiveSurfaces: number
  publisherHasSurface: boolean
  publisherLastUpdatedAt?: number
  now: number
}

/** Decides one publish attempt BEFORE any storage mutation: MIME/size
 * bounds, per-publisher replace throttle, and room-wide capacity. An
 * existing publisher may always replace its own surface (even at capacity);
 * brand-new publishers beyond the cap get surface_capacity_exceeded. */
export function evaluateSurfacePublish(
  input: SurfacePublishContext
): SurfacePolicyResult {
  if (!isSurfaceMimeType(input.mimeType))
    return { ok: false, error: "surface_mime_unsupported" }
  if (input.byteLength === 0) return { ok: false, error: "surface_empty" }
  if (input.byteLength > MAX_SURFACE_BYTES)
    return { ok: false, error: "surface_too_large" }
  if (input.declaredSize > 0 && input.declaredSize !== input.byteLength)
    return { ok: false, error: "surface_size_mismatch" }
  if (
    input.publisherHasSurface &&
    input.publisherLastUpdatedAt !== undefined &&
    input.now - input.publisherLastUpdatedAt < MIN_SURFACE_UPDATE_MS
  )
    return { ok: false, error: "surface_rate_limited" }
  if (
    !input.publisherHasSurface &&
    input.otherActiveSurfaces >= MAX_ACTIVE_AGENT_SURFACES
  )
    return { ok: false, error: "surface_capacity_exceeded" }
  return {
    ok: true,
    chunkCount: Math.ceil(input.byteLength / SURFACE_CHUNK_SIZE),
  }
}

/** DO storage key for one bounded binary chunk. Metadata never holds bytes;
 * chunks live only under these dedicated keys so prefix sweeps can clean
 * everything, including orphans from interrupted publishes. */
export function surfaceChunkKey(
  participantId: string,
  snapshotId: string,
  chunkIndex: number
): string {
  return `surface:${participantId}:${snapshotId}:${chunkIndex}`
}

export const SURFACE_KEY_PREFIX = "surface:"

/** Storage-hygiene pass for persisted metadata: invalid records are dropped
 * rather than rejected so a bad row can never wedge room loading. Returns
 * undefined when absent/invalid; `changed` reports whether the caller must
 * persist the repair. */
export function sanitizeStoredSurface(surface: unknown): {
  surface?: RoomSurfaceV1
  changed: boolean
} {
  if (!surface || typeof surface !== "object")
    return { surface: undefined, changed: surface !== undefined }
  const candidate = surface as Partial<RoomSurfaceV1>
  const valid =
    candidate.kind === "workspace-snapshot" &&
    typeof candidate.snapshotId === "string" &&
    candidate.snapshotId.length > 0 &&
    candidate.snapshotId.length <= 64 &&
    isSurfaceMimeType(candidate.mimeType) &&
    typeof candidate.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size > 0 &&
    candidate.size <= MAX_SURFACE_BYTES &&
    typeof candidate.updatedAt === "number" &&
    Number.isSafeInteger(candidate.updatedAt) &&
    candidate.updatedAt > 0
  if (valid) return { surface: candidate as RoomSurfaceV1, changed: false }
  return { surface: undefined, changed: true }
}
