import { useEffect, useRef, useState } from "react"

import { trackAnalyticsEvent } from "@common/utils"

interface AgentInviteControlProps {
  roomType: string
  /** The ACTUAL invite prompt (buildAgentInvitePrompt output) — the single
   * source of truth rendered read-only in the feature popover. */
  invitePrompt: string
  /** #236 follow-up: controlled popover state so the Live Transcript popover
   * can cross-open the invite popover without routing machinery. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * #236 follow-up: "Invite Agent" is a feature-first header control. Clicking
 * it opens a compact anchored popover that explains the Human mental model
 * (paste the prompt into the Agent you already use; the Agent handles
 * Free4Chat setup itself) and offers ONE explicit copy action with
 * in-popover feedback. Nothing is copied merely by opening the popover, and
 * AgentInviteCopied fires ONLY after a successful clipboard write — the
 * long-lived analytics semantics are unchanged.
 */
export default function AgentInviteControl({
  roomType,
  invitePrompt,
  open,
  onOpenChange,
}: AgentInviteControlProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        onOpenChange(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, onOpenChange])

  const copyInvite = () => {
    // Direct user activation only (Firefox/Safari require it for clipboard).
    if (!navigator.clipboard?.writeText) {
      setError(
        "Clipboard access is unavailable. Copy invite is not supported here."
      )
      return
    }
    setError("")
    navigator.clipboard
      .writeText(invitePrompt)
      .then(() => {
        // #236 follow-up: emit ONLY after the prompt actually reached the
        // clipboard — one event per successful write, never on open/view.
        trackAnalyticsEvent("AgentInviteCopied", {
          surface: "room",
          roomType,
        })
        setCopied(true)
      })
      .catch(() => {
        setError("Clipboard access was blocked. Try again.")
      })
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="Invite Agent"
        title="Copy an invite prompt for the Agent you already use"
        className="rounded-md border border-blue-700/70 bg-blue-900/30 px-3 py-1 text-xs text-blue-200 hover:bg-blue-800/50"
      >
        Invite Agent
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Invite an Agent"
          className="absolute left-1/2 top-full z-20 mt-1 max-h-[65dvh] w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-md border border-gray-700 bg-gray-800 p-3 text-xs text-gray-200 shadow-lg lg:left-auto lg:right-0 lg:translate-x-0"
        >
          <p className="font-medium text-gray-100">Invite an Agent</p>
          <p className="mt-1 text-gray-400">
            Bring an Agent you&apos;re already using into this Room.
          </p>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-gray-300">
            <li>Open your Agent.</li>
            <li>Copy the invite prompt below.</li>
            <li>Paste it into the Agent.</li>
          </ol>
          <p className="mt-1.5 text-gray-400">
            The Agent will set up Free4Chat locally if needed and join this Room
            itself. You normally do not need to install or configure anything
            manually.
          </p>
          <p className="mt-1 text-gray-400">
            The same local Free4Chat setup can also provide Room features such
            as Live Transcript when speech is configured.
          </p>

          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-gray-700 bg-gray-950 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
            {invitePrompt}
          </pre>

          <button
            type="button"
            onClick={copyInvite}
            className="mt-2 rounded-md border border-blue-700/70 bg-blue-900/30 px-3 py-1 text-blue-200 hover:bg-blue-800/50"
          >
            Copy invite prompt
          </button>
          {copied && (
            <p role="status" className="mt-2 text-emerald-300">
              ✓ Invite prompt copied. Paste it into your Agent.
            </p>
          )}
          {error && (
            <p role="status" className="mt-2 text-rose-300">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
