import { useEffect, useRef, useState } from "react"

import { trackAnalyticsEvent, withAnalyticsRoomId } from "@common/utils"

interface AgentInviteControlProps {
  roomType: string
  /**
   * #346: the canonical Room generation's analytics correlation id, exactly
   * as projected by RoomState. Absent until the server has projected
   * authoritative Room state; this control never invents one.
   */
  analyticsRoomId?: string
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
  analyticsRoomId,
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
        "无法访问剪贴板，因此无法在此处复制邀请内容。"
      )
      return
    }
    setError("")
    navigator.clipboard
      .writeText(invitePrompt)
      .then(() => {
        // #236 follow-up: emit ONLY after the prompt actually reached the
        // clipboard — one event per successful write, never on open/view.
        trackAnalyticsEvent(
          "AgentInviteCopied",
          withAnalyticsRoomId({ surface: "room", roomType }, analyticsRoomId)
        )
        setCopied(true)
      })
      .catch(() => {
        setError("剪贴板访问被阻止，请重试。")
      })
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="邀请 Agent"
        title="复制邀请提示词，发送给你正在使用的 Agent"
        className="rounded-md border border-blue-700/70 bg-blue-900/30 px-3 py-1 text-xs text-blue-200 hover:bg-blue-800/50"
      >
        邀请 Agent
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="邀请 Agent"
          className="room-feature-popover absolute left-1/2 top-full z-20 mt-1 max-h-[65dvh] w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-md border border-gray-700 bg-gray-800 p-3 text-xs text-gray-200 shadow-lg lg:left-auto lg:right-0 lg:translate-x-0"
        >
          <p className="font-medium text-gray-100">邀请 Agent</p>
          <p className="mt-1 text-gray-400">
            邀请你正在使用的 Agent 加入此房间。
          </p>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-gray-300">
            <li>打开你的 Agent。</li>
            <li>复制下面的邀请提示词。</li>
            <li>将提示词粘贴到 Agent 中。</li>
          </ol>
          <p className="mt-1.5 text-gray-400">
            如有需要，Agent 会在本地安装 Free4Chat，然后自行加入此房间。通常你无需手动安装或配置任何内容。
          </p>
          <p className="mt-1 text-gray-400">
            配置语音后，同一本地 Free4Chat 环境还可提供实时转录等房间功能。
          </p>

          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-gray-700 bg-gray-950 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
            {invitePrompt}
          </pre>

          <button
            type="button"
            onClick={copyInvite}
            className="mt-2 rounded-md border border-blue-700/70 bg-blue-900/30 px-3 py-1 text-blue-200 hover:bg-blue-800/50"
          >
            复制邀请提示词
          </button>
          {copied && (
            <p role="status" className="mt-2 text-emerald-300">
              ✓ 已复制邀请提示词。请将其粘贴到 Agent 中。
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
