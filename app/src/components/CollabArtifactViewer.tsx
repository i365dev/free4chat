import { useEffect, useRef, useState } from "react"

import type { RoomAttachmentRead } from "../room/types"

interface CollabArtifactViewerProps {
  attachmentId: string
  read: (attachmentId: string) => Promise<RoomAttachmentRead>
  onClose: () => void
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready"
      fileName: string
      mimeType: string
      objectUrl?: string
      text?: string
    }

const TEXT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/yaml",
])

/**
 * #117: on-demand Human inspection of ONE room collaboration artifact.
 * Bytes are fetched only when this component mounts (i.e., after an explicit
 * click), validated strictly by the hook boundary, and previewed safely:
 * images via a revoked-on-close object URL, text-like files as literal text
 * in a <pre>. Untrusted participant data — nothing here executes, navigates,
 * or grants anything to anyone.
 */
export default function CollabArtifactViewer({
  attachmentId,
  read,
  onClose,
}: CollabArtifactViewerProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" })
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ phase: "loading" })
    read(attachmentId)
      .then((result) => {
        if (cancelled) return
        if (TEXT_MIME.has(result.attachment.mimeType)) {
          const binary = atob(result.data)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1)
            bytes[index] = binary.charCodeAt(index)
          const text = new TextDecoder().decode(bytes)
          setState({
            phase: "ready",
            fileName: result.attachment.fileName,
            mimeType: result.attachment.mimeType,
            text,
          })
          return
        }
        const binary = atob(result.data)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1)
          bytes[index] = binary.charCodeAt(index)
        const blob = new Blob([bytes], { type: result.attachment.mimeType })
        const objectUrl = URL.createObjectURL(blob)
        objectUrlRef.current = objectUrl
        setState({
          phase: "ready",
          fileName: result.attachment.fileName,
          mimeType: result.attachment.mimeType,
          objectUrl,
        })
      })
      .catch(() => {
        if (!cancelled)
          setState({
            phase: "error",
            message: "Artifact is no longer available.",
          })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId])

  // Revocation is unconditional on unmount/close — the ONLY owner of the
  // object URL is this viewer instance.
  useEffect(() => {
    const ref = objectUrlRef
    return () => {
      if (ref.current) URL.revokeObjectURL(ref.current)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-xl border border-gray-700 bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-2">
          <p className="truncate text-sm font-medium text-white">
            {state.phase === "ready" ? state.fileName : "Attachment"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            Close
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto p-4">
          {state.phase === "loading" && (
            <p className="text-xs text-gray-400">Loading artifact…</p>
          )}
          {state.phase === "error" && (
            <p className="text-xs text-red-300">{state.message}</p>
          )}
          {state.phase === "ready" && state.objectUrl && (
            // Blob object URLs cannot go through next/image; same ephemeral
            // preview pattern as TextChatCard's file bubbles.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={state.objectUrl}
              alt={state.fileName}
              className="mx-auto max-h-[60vh] rounded-lg"
            />
          )}
          {state.phase === "ready" && state.text !== undefined && (
            <pre className="whitespace-pre-wrap break-words text-xs text-white/80">
              {state.text}
            </pre>
          )}
          <p className="mt-3 text-[10px] text-gray-500">
            Ephemeral room artifact — not live, not stored, not an
            authorization.
          </p>
        </div>
      </div>
    </div>
  )
}
