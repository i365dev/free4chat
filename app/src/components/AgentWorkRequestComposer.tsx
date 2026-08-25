import { useState } from "react"

interface AgentWorkRequestComposerProps {
  agentName: string
  capabilities?: string[]
  maxLength: number
  onCancel: () => void
  onSubmit: (summary: string) => void
}

/**
 * #113: Human → Agent structured work request composer. Deliberately tiny:
 * one bounded summary field. The Agent may accept or decline; submitting
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
  const trimmed = summary.trim()
  const canSend = trimmed.length > 0

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
            disabled={!canSend}
            onClick={() => canSend && onSubmit(trimmed)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              canSend
                ? "bg-blue-600 text-white hover:bg-blue-500"
                : "cursor-not-allowed bg-gray-700 text-gray-400"
            }`}
          >
            Send request
          </button>
        </div>
      </div>
    </div>
  )
}
