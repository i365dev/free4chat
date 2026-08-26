import { useRef, useState } from "react"

import { MAX_ROOM_ATTACHMENT_BYTES } from "@common/roomAttachments"

interface AgentWorkRequestComposerProps {
  agentName: string
  capabilities?: string[]
  maxLength: number
  onCancel: () => void
  onSubmit: (summary: string, files: File[]) => Promise<boolean>
}

const MAX_ARTIFACTS = 3
const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
])

/**
 * #113/#123: Human → Agent structured work request composer. One bounded
 * summary field plus optional file attachments (up to 3, existing Room
 * attachment MIME/size limits). The Agent may accept or decline; submitting
 * grants no new permissions and never invokes the Agent's tools directly.
 */
export default function AgentWorkRequestComposer({
  agentName,
  capabilities = [],
  maxLength,
  onCancel,
  onSubmit,
}: AgentWorkRequestComposerProps) {
  const [summary, setSummary] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const trimmed = summary.trim()
  const canSend = trimmed.length > 0 && !submitting

  const selectFiles = (selected: FileList | null) => {
    if (!selected) return
    setError(null)
    const next = [...files]
    for (const file of Array.from(selected)) {
      if (next.length >= MAX_ARTIFACTS) {
        setError("Maximum 3 artifacts per request.")
        break
      }
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        setError(`Unsupported file type: ${file.name}`)
        continue
      }
      if (file.size === 0) {
        setError(`Empty file: ${file.name}`)
        continue
      }
      if (file.size > MAX_ROOM_ATTACHMENT_BYTES) {
        setError(
          `File exceeds ${Math.floor(MAX_ROOM_ATTACHMENT_BYTES / 1024)} KiB: ${
            file.name
          }`
        )
        continue
      }
      next.push(file)
    }
    setFiles(next)
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async () => {
    if (!canSend || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const sent = await onSubmit(trimmed, files)
      // Only an explicit true lets the parent close this composer; any
      // other outcome leaves it open with actionable feedback.
      if (!sent) setError("Could not send request. Try again.")
    } catch {
      setError("Upload failed. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-4">
        <h3 className="text-sm font-medium text-white">
          Request work from {agentName}
        </h3>
        {capabilities.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {capabilities.map((capability) => (
              <span
                key={capability}
                className="rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-white/70"
              >
                {capability}
              </span>
            ))}
          </div>
        )}
        <textarea
          autoFocus
          value={summary}
          onChange={(event) =>
            setSummary(event.target.value.slice(0, maxLength))
          }
          placeholder="What would you like this Agent to do?"
          className="mt-3 h-24 w-full resize-none rounded-lg border border-gray-700 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-gray-500"
        />
        <p className="mt-1 text-right text-[10px] text-gray-500">
          {summary.length}/{maxLength}
        </p>
        <div className="mt-2">
          <label className="text-[11px] font-medium text-gray-400">
            Attach context (optional, max 3)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.log,.yaml,.yml"
            onChange={(event) => selectFiles(event.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={files.length >= 3 || submitting}
            className="mt-1 w-full rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-40"
          >
            Choose files…
          </button>
          {files.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {files.map((file, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between text-[10px] text-gray-400"
                >
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    aria-label={`Remove ${file.name}`}
                    className="text-gray-500 hover:text-white"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
        <p className="mt-2 text-[11px] leading-snug text-gray-400">
          The Agent may accept or decline. This request does not grant new
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
            data-testid="send-collab-request"
            disabled={!canSend || submitting}
            onClick={handleSubmit}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              canSend && !submitting
                ? "bg-blue-600 text-white hover:bg-blue-500"
                : "cursor-not-allowed bg-gray-700 text-gray-400"
            }`}
          >
            {submitting ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  )
}
