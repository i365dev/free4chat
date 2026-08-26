import { useEffect, useRef, useState } from "react"

import type { UserInfo } from "../common/types"

interface WorkspaceSnapshotsProps {
  participants: UserInfo[]
  getLocalRoomAuth: () => {
    roomId: string
    participantId: string
    token: string
  } | null
}

/**
 * Observable Agent Workspace v0 (#111): renders each visible Agent's latest
 * explicitly-published workspace snapshot. Observation only — no controls,
 * never a live stream. Bytes are fetched on demand for the exact current
 * snapshotId; one object URL per snapshot is kept and revoked when that
 * snapshot is replaced/removed or on unmount. Stale reads fail quietly; the
 * effect re-runs when newer metadata arrives.
 */
export default function WorkspaceSnapshots({
  participants,
  getLocalRoomAuth,
}: WorkspaceSnapshotsProps) {
  const [urls, setUrls] = useState<Record<string, string>>({})
  // object URLs alive right now, keyed by `${peerId}:${snapshotId}`.
  const urlRefs = useRef<Record<string, string>>({})

  const surfaces = participants.filter((p) => p.kind === "agent" && p.surface)

  useEffect(() => {
    const valid = new Set(
      surfaces.map((p) => `${p.peerId}:${p.surface!.snapshotId}`),
    )
    // Revoke URLs whose snapshot was replaced/removed.
    let revoked = false
    for (const [key, url] of Object.entries(urlRefs.current)) {
      if (!valid.has(key)) {
        URL.revokeObjectURL(url)
        delete urlRefs.current[key]
        revoked = true
      }
    }
    if (revoked) setUrls({ ...urlRefs.current })

    let cancelled = false
    for (const p of surfaces) {
      const key = `${p.peerId}:${p.surface!.snapshotId}`
      if (urlRefs.current[key]) continue
      const auth = getLocalRoomAuth()
      if (!auth) continue
      void (async () => {
        try {
          const response = await fetch("/api/room/surfaces/read", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Room-Id": auth.roomId,
              "X-Room-Participant-Id": auth.participantId,
              "X-Room-Participant-Token": auth.token,
            },
            body: JSON.stringify({
              sourceParticipantId: p.peerId,
              snapshotId: p.surface!.snapshotId,
            }),
          })
          // Stale or gone: fail quietly; newer state will re-trigger.
          if (!response.ok || cancelled) return
          const payload = (await response.json()) as {
            surface?: { mimeType?: string }
            data?: unknown
          }
          if (
            cancelled ||
            typeof payload.data !== "string" ||
            !payload.surface?.mimeType
          )
            return
          if (payload.surface.mimeType !== p.surface!.mimeType) return
          const binary = atob(payload.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1)
            bytes[i] = binary.charCodeAt(i)
          const blob = new Blob([bytes], { type: payload.surface.mimeType })
          const url = URL.createObjectURL(blob)
          // TOCTOU guard: a newer fetch may already own this slot.
          if (urlRefs.current[key] || cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          urlRefs.current[key] = url
          setUrls({ ...urlRefs.current })
        } catch {
          // Quiet failure: observation must never break the room UI.
        }
      })()
    }

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaces.map((p) => `${p.peerId}:${p.surface!.updatedAt}`).join("|")])

  useEffect(() => {
    const refs = urlRefs.current
    return () => {
      for (const url of Object.values(refs)) URL.revokeObjectURL(url)
    }
  }, [])

  if (surfaces.length === 0) return null

  return (
    <div className="border-b border-gray-800 px-3 py-2">
      <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
        Workspace snapshots — not live
      </p>
      <div className="flex flex-row gap-2 overflow-x-auto">
        {surfaces.map((p) => {
          const key = `${p.peerId}:${p.surface!.snapshotId}`
          const url = urls[key]
          return (
            <figure
              key={p.peerId}
              className="w-48 flex-none rounded-lg border border-gray-700 bg-gray-900/60"
            >
              {url ? (
                // Blob object URLs cannot be optimized by next/image; this
                // mirrors TextChatCard's ephemeral-preview pattern.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt={`${p.name} workspace snapshot`}
                  className="h-28 w-full rounded-t-lg object-cover"
                />
              ) : (
                <div className="flex h-28 w-full items-center justify-center rounded-t-lg text-xs text-gray-500">
                  loading…
                </div>
              )}
              <figcaption className="truncate px-2 py-1 text-[10px] text-gray-400">
                {p.name} · workspace snapshot · not live
              </figcaption>
            </figure>
          )
        })}
      </div>
    </div>
  )
}
