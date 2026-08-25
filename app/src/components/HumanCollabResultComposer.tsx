import { useState } from "react"

interface HumanCollabResultComposerProps {
  requestId: string
  status: "completed" | "failed"
  maxLength: number
  onCancel: () => void
  onSubmit: (summary: string) => void
}

/**
 * #121: Human terminal result for an Agent-originated request this Human
 * accepted. Records Room-level collaboration judgment ONLY — the result is
 * shared with the Agent and does not grant tools or permissions. v0 carries
 * no attachments and no structured details.
 */
export default function HumanCollabResultComposer({
  requestId,
  status,
  maxLength,
  onCancel,
  onSubmit,
}: HumanCollabResultComposerProps) {
  const [note, setNote] = useState("")
  const trimmed = note.trim()
  const canSend = trimmed.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-4">
        <h3 className="text-sm font-medium text-white">
          {status === "completed" ? "Completed" : "Failed"} — request{" "}
          <span className="font-mono text-[11px] text-gray-400">
            {requestId.slice(0, 8)}
          </span>
        </h3>
        <textarea
          autoFocus
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, maxLength))}
          placeholder={
            status === "completed"
              ? "What was the outcome?"
              : "Why did this fail?"
          }
          className="mt-3 h-24 w-full resize-none rounded-lg border border-gray-700 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-gray-500"
        />
        <p className="mt-1 text-right text-[10px] text-gray-500">
          {note.length}/{maxLength}
        </p>
        <p className="mt-2 text-[11px] leading-snug text-gray-400">
          Your result is shared with the Agent. It does not grant tools or
          permissions.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => canSend && onSubmit(trimmed)}
            data-testid={`send-collab-result-${status}`}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              canSend
                ? "bg-blue-600 text-white hover:bg-blue-500"
                : "cursor-not-allowed bg-gray-700 text-gray-400"
            }`}
          >
            Send result
          </button>
        </div>
      </div>
    </div>
  )
}
