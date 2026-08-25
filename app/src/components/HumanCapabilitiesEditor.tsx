import { useState } from "react"

interface HumanCapabilitiesEditorProps {
  initialCapabilities: string[]
  maxLength: number
  maxTokens: number
  onSave: (capabilities: string[]) => void
  onCancel: () => void
}

/**
 * #119: self-only editor for THIS Human's advertised capability list.
 * Discovery metadata only — capabilities help Agents discover what they may
 * ask about; they never grant permissions. Save sends a FULL replacement
 * list; Cancel mutates nothing.
 */
export default function HumanCapabilitiesEditor({
  initialCapabilities,
  maxLength,
  maxTokens,
  onSave,
  onCancel,
}: HumanCapabilitiesEditorProps) {
  const [tokens, setTokens] = useState<string[]>([...initialCapabilities])
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  const addToken = () => {
    const token = draft.trim().toLowerCase()
    if (!token) return
    if (token.length > maxLength) {
      setError(`Max ${maxLength} characters per capability.`)
      return
    }
    if (tokens.length >= maxTokens) {
      setError(`Max ${maxTokens} capabilities.`)
      return
    }
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(token)) {
      setError("Use lowercase namespaced tokens like review.code.")
      return
    }
    if (tokens.includes(token)) {
      setError("Already added.")
      return
    }
    setError(null)
    setDraft("")
    setTokens([...tokens, token])
  }

  const removeToken = (token: string) => {
    setError(null)
    setTokens(tokens.filter((existing) => existing !== token))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-4">
        <h3 className="text-sm font-medium text-white">
          Your capabilities in this Room
        </h3>
        {tokens.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tokens.map((token) => (
              <span
                key={token}
                className="flex items-center gap-1 rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-white/80"
              >
                {token}
                <button
                  type="button"
                  aria-label={`Remove ${token}`}
                  onClick={() => removeToken(token)}
                  className="text-gray-400 hover:text-white"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex gap-1.5">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                addToken()
              }
            }}
            placeholder="Add capability…"
            maxLength={maxLength}
            className="flex-1 rounded-lg border border-gray-700 bg-black/40 px-3 py-1.5 text-xs text-white placeholder:text-gray-500"
          />
          <button
            type="button"
            onClick={addToken}
            className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
          >
            Add
          </button>
        </div>
        {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
        <p className="mt-2 text-[11px] leading-snug text-gray-400">
          Capabilities help Agents discover what they may ask you to do. They do
          not grant permissions.
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
            onClick={() => onSave([...tokens])}
            data-testid="save-capabilities"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
