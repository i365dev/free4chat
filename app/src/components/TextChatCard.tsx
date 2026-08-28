import React, { useState, useRef, useEffect, memo } from "react"

import Avatar from "boring-avatars"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { LOCAL_PEER_ID } from "@common/consts"
import { ActionType, Message } from "@common/types"
import { strToBgColor, umamiEvent, hashRoom } from "@common/utils"
import { MAX_COLLAB_SUMMARY_LENGTH } from "@do/collab"

import CollabArtifactViewer from "./CollabArtifactViewer"
import {
  hasCollabTerminalResult,
  isCollabRequestAccepted,
  isCollabRequestAnswered,
} from "./collabUi"
import HumanCollabResultComposer from "./HumanCollabResultComposer"
import { resolveAgentTargetIds } from "../common/agentMentions"
import type { UserInfo } from "../common/types"
import type { RoomAttachmentRead } from "../room/types"

interface PendingFile {
  id: string
  fileName: string
  isImage: boolean
  error?: boolean
  errorMessage?: string
}

interface TextChatCardProps {
  room: string
  nickName: string
  messages: Message[]
  participants: UserInfo[]
  pendingFiles?: PendingFile[]
  onSendText: (text: string, targets?: string[]) => void
  onSendFile: (file: File) => void
  onSendAction: (
    actionType: ActionType,
    actionPayload: Record<string, string>
  ) => void
  /** #115: real authenticated Room participant id of THIS browser — used to
   * decide whether an incoming collab request targets this Human. Public
   * room identity, not a credential. */
  localParticipantId?: string
  /** #115: submit accepted/declined for a request addressed to this Human. */
  onCollabRespond?: (
    requestId: string,
    decision: "accepted" | "declined"
  ) => void
  /** #117: authenticated on-demand read of one room collaboration artifact. */
  onReadArtifact?: (attachmentId: string) => Promise<RoomAttachmentRead>
  /** #121: submit a Human terminal result for a request this Human accepted. */
  onCollabResult?: (
    requestId: string,
    status: "completed" | "failed",
    summary: string
  ) => void
}

const GAMES = [
  {
    id: "skribbl",
    emoji: "✏️",
    name: "skribbl.io",
    desc: "You draw, others guess",
    url: "https://skribbl.io",
  },
  {
    id: "gartic",
    emoji: "🖼️",
    name: "Gartic Phone",
    desc: "Drawing telephone chaos",
    url: "https://garticphone.com",
  },
  {
    id: "jklm",
    emoji: "💣",
    name: "BombParty",
    desc: "Type words before bomb explodes",
    url: "https://jklm.fun",
  },
  {
    id: "codenames",
    emoji: "🕵️",
    name: "Codenames",
    desc: "Team word deduction game",
    url: "https://codenames.game",
  },
  {
    id: "bga",
    emoji: "🎲",
    name: "Board Game Arena",
    desc: "800+ board games (account required)",
    url: "https://boardgamearena.com",
  },
]

function extractText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return ""
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node)
  }
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children)
  }
  return ""
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (permissions/insecure context): stay silent.
    }
  }
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700 bg-gray-950">
      <div className="flex items-center justify-between border-b border-gray-700 px-3 py-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-[10px] text-gray-400 transition-colors hover:text-white"
          title="Copy code"
          aria-label="Copy code"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-x-auto p-3 text-xs leading-relaxed text-gray-200">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Safe-by-default GFM rendering: react-markdown without rehype-raw never
// executes raw HTML, the default URL transform blocks javascript: URLs, and
// Markdown images are intentionally not rendered (no remote content loading).
const markdownComponents = {
  a: (props: React.ComponentProps<"a">) => (
    <a
      target="_blank"
      rel="noopener noreferrer"
      {...props}
      className="underline underline-offset-2 opacity-90 hover:opacity-100"
    />
  ),
  img: () => null,
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children[0] : children
    if (React.isValidElement(child)) {
      const props = child.props as {
        className?: string
        children?: React.ReactNode
      }
      const language = /language-(\S+)/.exec(props.className ?? "")?.[1] ?? ""
      // Strip the single fence-syntax trailing newline from display and copy.
      return (
        <CodeBlock
          language={language}
          code={extractText(props.children).replace(/\n$/, "")}
        />
      )
    }
    return <pre className="scrollbar-thin overflow-x-auto">{children}</pre>
  },
  code: (props: React.ComponentProps<"code">) => (
    <code
      className="rounded bg-gray-700/70 px-1 py-0.5 font-mono text-[13px]"
      {...props}
    />
  ),
  table: (props: React.ComponentProps<"table">) => (
    <div className="scrollbar-thin my-2 overflow-x-auto">
      <table
        {...props}
        className="w-full border-collapse text-left text-xs [&_td]:border [&_td]:border-gray-700 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-700 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold"
      />
    </div>
  ),
}

const MessageMarkdown = memo(function MessageMarkdown({
  text,
}: {
  text: string
}) {
  return (
    <div className="markdown-body break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

// #165: the recipient cue is derived ONLY from structured routing metadata
// (Message.targets resolved against the current roster) — never from parsing
// the message body. It is plain rendered text, so target metadata cannot
// execute content. Targets whose @Name the body already shows are skipped to
// avoid duplicate mentions.
interface RecipientCue {
  label: string
  isName: boolean
}

function hasCompleteMention(text: string, name: string): boolean {
  if (!name) return false
  const pattern = new RegExp(
    `(?:^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s)`
  )
  return pattern.test(text)
}

function messageRecipientCues(
  msg: Message,
  participants: UserInfo[]
): RecipientCue[] {
  if (msg.type !== "text" || !msg.targets?.length) return []
  const body = msg.text ?? ""
  const cues: RecipientCue[] = []
  let unresolved = 0
  for (const target of msg.targets) {
    const participant = participants.find((p) => p.peerId === target)
    if (!participant) {
      unresolved += 1
      continue
    }
    if (!hasCompleteMention(body, participant.name))
      cues.push({ label: participant.name, isName: true })
  }
  if (unresolved > 0)
    cues.push({
      label: unresolved === 1 ? "participant" : `${unresolved} participants`,
      isName: false,
    })
  return cues
}

function getOrCreateWhiteboardUrl(room: string): string {
  const storageKey = `wb-key-${room}`
  let key = localStorage.getItem(storageKey)
  if (!key) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    key = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")
      .slice(0, 22)
    localStorage.setItem(storageKey, key)
  }
  const roomId = room
    .split("")
    .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0xffffff, 0)
    .toString(16)
    .padStart(6, "0")
  return `https://excalidraw.com/#room=${roomId},${key}`
}

function PollCard({
  msg,
  isSelf,
  allMessages,
  myPeerId,
  onVote,
}: {
  msg: Message
  isSelf: boolean
  allMessages: Message[]
  myPeerId: string
  onVote: (pollId: string, option: string) => void
}) {
  const pollId = msg.actionPayload?.pollId ?? ""
  const question = msg.actionPayload?.question ?? ""
  const options = (msg.actionPayload?.options ?? "").split("||")

  const votes = allMessages.filter(
    (m) =>
      m.type === "action" &&
      m.actionType === "vote" &&
      m.actionPayload?.pollId === pollId
  )
  const myVote = votes.find((v) => v.peerId === myPeerId)?.actionPayload?.option

  const containerClass = isSelf
    ? "mr-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3"
    : "ml-2 rounded-br-3xl rounded-tr-3xl rounded-tl-xl px-4 py-3"

  return (
    <div
      className={containerClass + " min-w-[180px]"}
      style={{ backgroundColor: strToBgColor(msg.name) }}
    >
      <p className="mb-2 text-sm font-semibold text-white">📊 {question}</p>
      <div className="flex flex-col gap-1">
        {options.map((opt) => {
          const count = votes.filter(
            (v) => v.actionPayload?.option === opt
          ).length
          const total = votes.length
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const voted = myVote === opt
          return (
            <button
              key={opt}
              onClick={() => !myVote && onVote(pollId, opt)}
              disabled={!!myVote}
              className={`relative flex items-center justify-between overflow-hidden rounded-lg px-3 py-1.5 text-left text-xs transition
                ${voted ? "ring-2 ring-white/60" : ""}
                ${
                  myVote
                    ? "cursor-default opacity-90"
                    : "cursor-pointer hover:brightness-110"
                }`}
              style={{ backgroundColor: "rgba(0,0,0,0.25)" }}
            >
              {myVote && (
                <span
                  className="absolute inset-y-0 left-0 rounded-lg bg-white/20 transition-all"
                  style={{ width: `${pct}%` }}
                />
              )}
              <span className="relative text-white">{opt}</span>
              {myVote && (
                <span className="relative text-white/70">
                  {count} {count === 1 ? "vote" : "votes"}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {myVote && (
        <p className="mt-1.5 text-right text-xs text-white/50">
          {votes.length} total
        </p>
      )}
    </div>
  )
}

function GameCard({ msg, isSelf }: { msg: Message; isSelf: boolean }) {
  const containerClass = isSelf
    ? "mr-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3"
    : "ml-2 rounded-br-3xl rounded-tr-3xl rounded-tl-xl px-4 py-3"

  const gameId = msg.actionPayload?.gameId ?? ""
  const game = GAMES.find((g) => g.id === gameId)
  if (!game) return null

  return (
    <div
      className={containerClass}
      style={{ backgroundColor: strToBgColor(msg.name) }}
    >
      <a
        href={game.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 text-white underline-offset-2 hover:underline"
      >
        <span className="text-lg">{game.emoji}</span>
        <div>
          <p className="text-sm font-semibold">{game.name}</p>
          <p className="text-xs text-white/60">{game.desc}</p>
        </div>
      </a>
    </div>
  )
}

function ActionCard({
  msg,
  isSelf,
  allMessages,
  myPeerId,
  onVote,
  localParticipantId,
  onCollabRespond,
  onViewArtifact,
  onCollabResult,
  onOpenResultComposer,
}: {
  msg: Message
  isSelf: boolean
  allMessages: Message[]
  myPeerId: string
  onVote: (pollId: string, option: string) => void
  localParticipantId?: string
  onCollabRespond?: (
    requestId: string,
    decision: "accepted" | "declined"
  ) => void
  onViewArtifact?: (attachmentId: string) => void
  onCollabResult?: (
    requestId: string,
    status: "completed" | "failed",
    summary: string
  ) => void
  onOpenResultComposer?: (target: {
    requestId: string
    status: "completed" | "failed"
  }) => void
}) {
  if (msg.actionType === "reaction") return null

  if (msg.actionType === "collab" && msg.collab) {
    const collab = msg.collab
    // #115: lifecycle-derived answered state — the message log IS the
    // record. A later accepted/declined for the same requestId means the
    // decision is made; never keep authoritative state in React.
    const answered = isCollabRequestAnswered(allMessages, collab.requestId)
    const accepted = isCollabRequestAccepted(allMessages, collab.requestId)
    const terminal = hasCollabTerminalResult(allMessages, collab.requestId)
    const declinedPresent = allMessages.some(
      (m) =>
        m.collab?.requestId === collab.requestId && m.collab.kind === "declined"
    )
    // #121: terminal controls appear ONLY when THIS Human is the target,
    // the request came from someone else, it was ACCEPTED, and no terminal
    // result exists yet — lifecycle derived from canonical messages.
    const showResultControls =
      collab.kind === "request" &&
      Boolean(onCollabResult) &&
      Boolean(localParticipantId) &&
      collab.targetParticipantId === localParticipantId &&
      collab.fromParticipantId !== localParticipantId &&
      accepted &&
      !terminal &&
      !declinedPresent
    // Response controls appear ONLY when THIS Human is the request target
    // and the request came from someone else (never on own outbound
    // requests, Agent-targeted requests, or already-answered ones).
    const showRespond =
      collab.kind === "request" &&
      Boolean(onCollabRespond) &&
      Boolean(localParticipantId) &&
      collab.targetParticipantId === localParticipantId &&
      collab.fromParticipantId !== localParticipantId &&
      !answered
    const icons: Record<string, string> = {
      request: "🤝",
      accepted: "✅",
      declined: "🚫",
      completed: "🎯",
      failed: "❌",
    }
    return (
      <div
        className={`max-w-xs rounded-xl border border-white/10 bg-gray-900/80 px-3 py-2 text-xs text-white/80 ${
          isSelf
            ? "mr-2 rounded-br-3xl rounded-tl-xl rounded-tr-3xl"
            : "ml-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl"
        }`}
      >
        <p className="flex items-center gap-1.5 font-medium text-white">
          <span>{icons[collab.kind] ?? "🤝"}</span>
          {collab.kind === "request"
            ? `${msg.name} → work request`
            : `${msg.name} ${collab.kind} the request`}
        </p>
        {collab.summary && (
          <p className="mt-1 break-words text-white/70">{collab.summary}</p>
        )}
        {collab.details &&
          Object.entries(collab.details)
            .slice(0, 6)
            .map(([key, value]) => (
              <p
                key={key}
                className="mt-0.5 break-all text-[11px] text-white/50"
              >
                {key}: {value}
              </p>
            ))}
        {(collab.attachmentIds ?? []).length > 0 && onViewArtifact && (
          <div className="mt-1 flex flex-col gap-0.5">
            {collab.attachmentIds!.map((attachmentId, index) => (
              <button
                key={attachmentId}
                type="button"
                onClick={() => onViewArtifact(attachmentId)}
                className="w-full truncate rounded-md bg-blue-600/20 px-2 py-1 text-left text-[11px] text-blue-200 hover:bg-blue-600/40"
              >
                📎 View artifact{" "}
                {collab.attachmentIds!.length > 1 ? index + 1 : ""}
              </button>
            ))}
          </div>
        )}
        {showRespond && (
          <div className="mt-2 border-t border-white/10 pt-1.5">
            <p className="text-[10px] leading-snug text-gray-400">
              Your response is shared with the Agent and does not grant new
              permissions.
            </p>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => onCollabRespond?.(collab.requestId, "accepted")}
                className="rounded-md bg-emerald-600/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onCollabRespond?.(collab.requestId, "declined")}
                className="rounded-md border border-gray-600 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
              >
                Decline
              </button>
            </div>
          </div>
        )}
        {!showRespond && showResultControls && (
          <div className="mt-2 border-t border-white/10 pt-1.5">
            <p className="text-[10px] leading-snug text-gray-400">
              Your result is shared with the Agent and does not grant tools or
              permissions.
            </p>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onOpenResultComposer({
                    requestId: collab.requestId,
                    status: "completed",
                  })
                }
                className="rounded-md bg-emerald-600/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
              >
                Mark complete
              </button>
              <button
                type="button"
                onClick={() =>
                  onOpenResultComposer({
                    requestId: collab.requestId,
                    status: "failed",
                  })
                }
                className="rounded-md border border-gray-600 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
              >
                Mark failed
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (msg.actionType === "whiteboard") {
    const url = msg.actionPayload?.url ?? ""
    const containerClass = isSelf
      ? "mr-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3"
      : "ml-2 rounded-br-3xl rounded-tr-3xl rounded-tl-xl px-4 py-3"
    return (
      <div
        className={containerClass}
        style={{ backgroundColor: strToBgColor(msg.name) }}
      >
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-white underline-offset-2 hover:underline"
        >
          <span className="text-lg">📋</span>
          <span className="text-sm font-medium">Open Whiteboard</span>
        </a>
      </div>
    )
  }

  if (msg.actionType === "poll") {
    return (
      <PollCard
        msg={msg}
        isSelf={isSelf}
        allMessages={allMessages}
        myPeerId={myPeerId}
        onVote={onVote}
      />
    )
  }

  if (msg.actionType === "vote") {
    const containerClass = isSelf ? "mr-2 text-right" : "ml-2 text-left"
    return (
      <div className={`${containerClass} text-xs italic text-white/30`}>
        voted
      </div>
    )
  }

  if (msg.actionType === "game") {
    return <GameCard msg={msg} isSelf={isSelf} />
  }

  return null
}

function FileMessageBubble({ msg, isSelf }: { msg: Message; isSelf: boolean }) {
  const isImage = msg.type === "image"
  const containerClass = isSelf
    ? "mr-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3"
    : "ml-2 rounded-br-3xl rounded-tr-3xl rounded-tl-xl px-4 py-3"

  return (
    <div
      className={containerClass}
      style={{ backgroundColor: strToBgColor(msg.name) }}
    >
      {isImage ? (
        <a href={msg.fileLink} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={msg.fileLink}
            alt={msg.fileName || "image"}
            className="max-h-40 w-full max-w-xs rounded object-contain"
          />
        </a>
      ) : (
        <a
          href={msg.fileLink}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 underline"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-4 w-4 shrink-0"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"
            />
          </svg>
          <span className="max-w-[160px] truncate">{msg.fileName}</span>
          {msg.fileSize && (
            <span className="text-xs opacity-70">
              ({(msg.fileSize / 1024).toFixed(1)}KB)
            </span>
          )}
        </a>
      )}
    </div>
  )
}

function PollCreator({
  onSend,
  onCancel,
}: {
  onSend: (question: string, options: string[]) => void
  onCancel: () => void
}) {
  const [question, setQuestion] = useState("")
  const [options, setOptions] = useState(["", ""])

  const canSubmit =
    question.trim() && options.filter((o) => o.trim()).length >= 2

  return (
    <div className="mb-2 rounded-xl border border-gray-600 bg-gray-900 p-3">
      <p className="mb-2 text-xs font-semibold text-gray-300">📊 Create Poll</p>
      <input
        autoFocus
        className="mb-2 w-full rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
        placeholder="Question..."
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />
      {options.map((opt, i) => (
        <input
          key={i}
          className="mb-1.5 w-full rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-500"
          placeholder={`Option ${i + 1}`}
          value={opt}
          onChange={(e) => {
            const next = [...options]
            next[i] = e.target.value
            setOptions(next)
          }}
        />
      ))}
      {options.length < 4 && (
        <button
          type="button"
          onClick={() => setOptions([...options, ""])}
          className="mb-2 text-xs text-gray-500 hover:text-gray-300"
        >
          + Add option
        </button>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() =>
            onSend(
              question.trim(),
              options.filter((o) => o.trim())
            )
          }
          className="flex-1 rounded-lg bg-rose-600 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-40"
        >
          Send
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function GamesMenu({
  onSelect,
  onBack,
  menuRef,
}: {
  onSelect: (gameId: string) => void
  onBack: () => void
  menuRef?: React.RefObject<HTMLDivElement>
}) {
  return (
    <>
      <div className="fixed inset-0 z-20 md:hidden" onClick={onBack} />
      <div
        ref={menuRef}
        className="fixed bottom-0 left-0 right-0 z-30 max-h-[60vh] overflow-y-auto rounded-t-xl border-t border-gray-600 bg-gray-800 py-1 shadow-xl md:absolute md:bottom-full md:left-0 md:right-auto md:mb-1 md:max-h-72 md:w-52 md:rounded-lg md:border md:border-gray-600"
      >
        <button
          type="button"
          onClick={onBack}
          className="flex w-full items-center gap-1 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
        >
          ← Back
        </button>
        <div className="mx-2 my-1 border-t border-gray-700" />
        {GAMES.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onSelect(g.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-700"
          >
            <span>{g.emoji}</span>
            <div>
              <p className="text-sm text-gray-200">{g.name}</p>
              <p className="text-xs text-gray-500">{g.desc}</p>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

export default function TextChatCard({
  room,
  nickName,
  messages,
  participants,
  pendingFiles = [],
  onSendText,
  onSendFile,
  onSendAction,
  localParticipantId,
  onCollabRespond,
  onReadArtifact,
  onCollabResult,
}: TextChatCardProps) {
  const [message, setMessage] = useState<string>("")
  const [submenu, setSubmenu] = useState<"more" | "games" | null>(null)
  const [showPollCreator, setShowPollCreator] = useState<boolean>(false)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [artifactId, setArtifactId] = useState<string | null>(null)
  // #121: pending Human terminal result ({requestId,status} | null).
  const [resultTarget, setResultTarget] = useState<{
    requestId: string
    status: "completed" | "failed"
  } | null>(null)
  const [selectedAgents, setSelectedAgents] = useState<
    Array<{ id: string; name: string }>
  >([])
  const [pickerDismissed, setPickerDismissed] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const gamesMenuRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  // Coarse pointers (touch) keep Enter as a newline so multiline editing
  // stays natural on mobile keyboards; sending uses the send button.
  const [isCoarsePointer] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false
  )

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, pendingFiles])

  // Auto-grow the textarea with content up to a bounded height, then let it
  // scroll internally instead of consuming the whole Room.
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [message])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const inBtn = moreBtnRef.current?.contains(target)
      const inMoreMenu = moreMenuRef.current?.contains(target)
      const inGamesMenu = gamesMenuRef.current?.contains(target)
      if (!inBtn && !inMoreMenu && !inGamesMenu) {
        setSubmenu(null)
      }
    }
    if (submenu) document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [submenu])

  const closeMenu = () => {
    setSubmenu(null)
  }

  const sendCurrentMessage = () => {
    if (message.trim() === "") return
    onSendText(
      message.trim(),
      resolveAgentTargetIds(message.trim(), connectedAgents, selectedAgents)
    )
    setMessage("")
    setSelectedAgents([])
  }

  const handleSend = sendCurrentMessage

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (pickerVisible) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setPickerIndex((i) => (i + 1) % pickerLength)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setPickerIndex((i) => (i - 1 + pickerLength) % pickerLength)
        return
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !isComposingRef.current
      ) {
        event.preventDefault()
        if (showAgentPicker) selectAgent(mentionAgents[pickerIndex])
        else commitPicker(pickerIndex)
        return
      }
      if (event.key === "Escape") {
        setPickerDismissed(true)
        setPickerIndex(0)
        return
      }
    }
    if (event.key === "Enter" && !isComposingRef.current) {
      // Shift+Enter inserts a newline; on coarse (touch) pointers Enter also
      // stays a newline and sending happens through the send button.
      if (event.shiftKey || isCoarsePointer) return
      event.preventDefault()
      sendCurrentMessage()
    }
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      onSendFile(file)
      event.target.value = ""
    }
  }

  const handleWhiteboard = () => {
    closeMenu()
    const url = getOrCreateWhiteboardUrl(room)
    umamiEvent("ChatAction", { type: "whiteboard", roomHash: hashRoom(room) })
    onSendAction("whiteboard", { url })
  }

  const handlePoll = () => {
    closeMenu()
    setShowPollCreator(true)
  }

  const handlePollSend = (question: string, options: string[]) => {
    setShowPollCreator(false)
    umamiEvent("ChatAction", { type: "poll", roomHash: hashRoom(room) })
    onSendAction("poll", {
      pollId: Date.now().toString(),
      question,
      options: options.join("||"),
    })
  }

  const handleGameSelect = (gameId: string) => {
    closeMenu()
    umamiEvent("ChatAction", { type: "game", gameId, roomHash: hashRoom(room) })
    onSendAction("game", { gameId })
  }

  const handleVote = (pollId: string, option: string) => {
    umamiEvent("ChatAction", { type: "vote", roomHash: hashRoom(room) })
    onSendAction("vote", { pollId, option })
  }

  const slashCommands = [
    {
      icon: "🎨",
      label: "/draw",
      desc: "Open whiteboard",
      action: () => {
        setMessage("")
        handleWhiteboard()
      },
    },
    {
      icon: "📊",
      label: "/poll",
      desc: "Create a poll",
      action: () => {
        setMessage("")
        handlePoll()
      },
    },
    {
      icon: "🎮",
      label: "/games",
      desc: "Share a game link",
      action: () => {
        setMessage("")
        setSubmenu("games")
      },
    },
  ]

  const pickerItems =
    message === "/"
      ? slashCommands
      : message.startsWith("/") && !message.includes(" ")
      ? slashCommands.filter((c) => c.label.startsWith(message.toLowerCase()))
      : []

  const showPicker = pickerItems.length > 0

  const connectedAgents = participants.filter(
    (participant) =>
      participant.kind === "agent" && participant.peerId !== LOCAL_PEER_ID
  )
  const caretPosition = textRef.current?.selectionStart ?? message.length
  const mentionMatch = message
    .slice(0, caretPosition)
    .match(/(?:^|\s)@([^\s@]*)$/)
  const mentionQuery = mentionMatch?.[1] ?? null
  const mentionAgents =
    mentionQuery === null
      ? []
      : connectedAgents.filter((agent) =>
          agent.name.toLowerCase().startsWith(mentionQuery.toLowerCase())
        )
  const showAgentPicker = !pickerDismissed && mentionAgents.length > 0

  const selectAgent = (agent: UserInfo) => {
    if (!agent) return
    const caret = textRef.current?.selectionStart ?? message.length
    const before = message.slice(0, caret)
    const match = before.match(/(?:^|\s)@([^\s@]*)$/)
    if (!match) return
    const start = caret - match[0].length + (match[0].startsWith(" ") ? 1 : 0)
    const nextMessage = `${message.slice(0, start)}@${
      agent.name
    } ${message.slice(caret)}`
    setMessage(nextMessage)
    setSelectedAgents((current) =>
      current.some((selected) => selected.id === agent.peerId)
        ? current
        : [...current, { id: agent.peerId, name: agent.name }]
    )
    // The just-completed @token is done: hide the picker immediately. The
    // interim render still sees the pre-insertion caret and would otherwise
    // reshow (and swallow the next Enter); any later edit reopens matching.
    setPickerDismissed(true)
    setPickerIndex(0)
    window.setTimeout(() => {
      const nextCaret = start + agent.name.length + 2
      textRef.current?.focus()
      textRef.current?.setSelectionRange(nextCaret, nextCaret)
    }, 0)
  }

  const pickerVisible = showAgentPicker || showPicker
  const pickerLength = showAgentPicker
    ? mentionAgents.length
    : pickerItems.length

  const commitPicker = (idx: number) => {
    pickerItems[idx]?.action()
    setPickerIndex(0)
  }

  return (
    <>
      <style>{`
      .scrollbar-thin::-webkit-scrollbar { width: 4px; height: 4px; }
      .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
      .scrollbar-thin::-webkit-scrollbar-thumb { background: #374151; border-radius: 9999px; }
      .scrollbar-thin::-webkit-scrollbar-thumb:hover { background: #4b5563; }
      .markdown-body > :first-child { margin-top: 0; }
      .markdown-body > :last-child { margin-bottom: 0; }
      .markdown-body p { margin: 0.375rem 0; }
      .markdown-body h1, .markdown-body h2, .markdown-body h3,
      .markdown-body h4, .markdown-body h5, .markdown-body h6 {
        font-weight: 600; line-height: 1.3; margin: 0.75rem 0 0.375rem; color: #ffffff;
      }
      .markdown-body h1 { font-size: 1.125rem; }
      .markdown-body h2 { font-size: 1rem; }
      .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 0.925rem; }
      .markdown-body ul { list-style: disc; padding-left: 1.25rem; margin: 0.375rem 0; }
      .markdown-body ol { list-style: decimal; padding-left: 1.25rem; margin: 0.375rem 0; }
      .markdown-body li { margin: 0.125rem 0; }
      .markdown-body li > input[type="checkbox"] { margin-right: 0.375rem; }
      .markdown-body blockquote {
        border-left: 3px solid #4b5563; padding-left: 0.75rem; margin: 0.5rem 0; color: #9ca3af;
      }
      .markdown-body hr { border-color: #374151; margin: 0.75rem 0; }
    `}</style>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="scrollbar-thin flex-1 overflow-y-auto p-4 text-sm">
          {messages.length === 0 && (
            <p className="mt-4 text-center text-xs text-gray-500">
              No messages yet
            </p>
          )}
          {messages.map((p, i) => {
            if (p.type === "action" && p.actionType === "reaction") return null
            const isSelf = p.peerId === LOCAL_PEER_ID
            const recipientCues = messageRecipientCues(p, participants)
            return (
              <div
                className={`mb-4 flex w-full items-end ${
                  isSelf ? "flex-row-reverse" : "flex-row"
                }`}
                key={i}
              >
                <div className={`flex-shrink-0 ${isSelf ? "ml-2" : "mr-2"}`}>
                  <Avatar size={28} variant="beam" name={p.name} />
                </div>
                <div className="min-w-0 flex-1">
                  {!isSelf && (
                    <p className="mb-1 ml-1 text-xs text-gray-400">
                      {p.name}
                      {p.kind === "agent" && (
                        <span className="ml-1 text-[10px] text-blue-300">
                          🤖 Agent
                        </span>
                      )}
                    </p>
                  )}
                  {p.type === "text" ? (
                    <div
                      className={
                        isSelf
                          ? "ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-white"
                          : "w-fit max-w-full rounded-2xl rounded-tl-md border border-white/10 bg-gray-800/80 px-4 py-2.5 text-gray-100"
                      }
                    >
                      {recipientCues.length > 0 && (
                        <p className="mb-1 flex flex-wrap items-center gap-x-1 text-[11px] font-medium text-white/75">
                          <span>→</span>
                          {recipientCues.map((cue, index) => (
                            <span key={index}>
                              {cue.isName ? `@${cue.label}` : cue.label}
                            </span>
                          ))}
                        </p>
                      )}
                      <MessageMarkdown text={p.text ?? ""} />
                    </div>
                  ) : p.type === "action" ? (
                    <ActionCard
                      msg={p}
                      isSelf={isSelf}
                      allMessages={messages}
                      myPeerId={LOCAL_PEER_ID}
                      onVote={handleVote}
                      localParticipantId={localParticipantId}
                      onCollabRespond={onCollabRespond}
                      onViewArtifact={(attachmentId) =>
                        setArtifactId(attachmentId)
                      }
                      onCollabResult={onCollabResult}
                      onOpenResultComposer={(target) => setResultTarget(target)}
                    />
                  ) : (
                    <FileMessageBubble msg={p} isSelf={isSelf} />
                  )}
                </div>
              </div>
            )
          })}
          {pendingFiles.map((f) => (
            <div
              key={f.id}
              className="mb-4 flex w-full flex-row-reverse items-end"
            >
              <div className="ml-2 flex-shrink-0">
                <Avatar size={28} variant="beam" name={nickName} />
              </div>
              <div style={{ maxWidth: "72%" }}>
                <div
                  className={`flex items-center gap-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3 ${
                    f.error ? "bg-red-700/60" : "bg-blue-600/60"
                  }`}
                >
                  {f.error ? (
                    <span className="text-xs text-white/80">
                      {f.errorMessage ?? "Failed to send"}
                    </span>
                  ) : (
                    <>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        className="h-4 w-4 animate-spin text-white/70"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      <span className="max-w-[140px] truncate text-xs text-white/70">
                        {f.fileName}
                      </span>
                      <span className="text-xs text-white/40">Sending…</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {showPollCreator && (
          <PollCreator
            onSend={handlePollSend}
            onCancel={() => setShowPollCreator(false)}
          />
        )}

        <div className="relative flex flex-none items-end gap-2 border-t border-gray-700 p-3">
          {pickerVisible && (
            <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-gray-600 bg-gray-800 shadow-xl">
              {(showAgentPicker ? mentionAgents : pickerItems).map(
                (item, i) => (
                  <button
                    key={showAgentPicker ? item.peerId : item.label}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      if (showAgentPicker) selectAgent(item as UserInfo)
                      else commitPicker(i)
                    }}
                    onTouchEnd={(e) => {
                      e.preventDefault()
                      if (showAgentPicker) selectAgent(item as UserInfo)
                      else commitPicker(i)
                    }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                      i === pickerIndex
                        ? "bg-gray-700 text-white"
                        : "text-gray-300 hover:bg-gray-700"
                    }`}
                  >
                    {showAgentPicker ? (
                      <>
                        <span className="text-base">🤖</span>
                        <span className="font-medium">{item.name}</span>
                        <span className="text-xs text-gray-500">Agent</span>
                      </>
                    ) : (
                      <>
                        <span className="text-base">{item.icon}</span>
                        <span className="font-medium">{item.label}</span>
                        <span className="text-xs text-gray-500">
                          {item.desc}
                        </span>
                      </>
                    )}
                  </button>
                )
              )}
            </div>
          )}
          <div ref={moreBtnRef} className="relative">
            <button
              type="button"
              onClick={() => setSubmenu((v) => (v === "more" ? null : "more"))}
              className="rounded-full bg-gray-700 p-2.5 text-gray-300 transition hover:bg-gray-600 hover:text-white"
              title="More actions"
              aria-label="More actions"
              aria-expanded={submenu === "more" || submenu === "games"}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="h-4 w-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4.5v15m7.5-7.5h-15"
                />
              </svg>
            </button>
            {submenu === "more" && (
              <>
                <div
                  className="fixed inset-0 z-20 md:hidden"
                  onClick={closeMenu}
                />
                <div
                  ref={moreMenuRef}
                  className="fixed bottom-0 left-0 right-0 z-30 rounded-t-xl border-t border-gray-600 bg-gray-800 py-1 shadow-xl md:absolute md:bottom-full md:left-0 md:right-auto md:mb-1 md:w-48 md:rounded-lg md:border md:border-gray-600"
                >
                  <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">
                    Room actions
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      // Close before opening the native picker so the menu
                      // (mobile bottom sheet) is gone when the picker returns.
                      closeMenu()
                      fileInputRef.current?.click()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-gray-200 hover:bg-gray-700"
                  >
                    <span>📎</span> Attach file
                  </button>
                  <button
                    type="button"
                    onClick={handleWhiteboard}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-gray-200 hover:bg-gray-700"
                  >
                    <span>🎨</span> Whiteboard
                  </button>
                  <button
                    type="button"
                    onClick={handlePoll}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-gray-200 hover:bg-gray-700"
                  >
                    <span>📊</span> Poll
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubmenu("games")}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-gray-200 hover:bg-gray-700"
                  >
                    <span>🎮</span> Games
                  </button>
                </div>
              </>
            )}
            {submenu === "games" && (
              <GamesMenu
                onSelect={handleGameSelect}
                onBack={() => setSubmenu(null)}
                menuRef={gamesMenuRef}
              />
            )}
          </div>
          <textarea
            ref={textRef}
            rows={1}
            className="scrollbar-thin max-h-40 flex-1 resize-none overflow-y-auto rounded-xl bg-gray-900 px-3 py-2 text-sm leading-relaxed text-white placeholder-gray-500 focus:outline-none"
            value={message}
            onKeyDown={handleKeyDown}
            onChange={(e) => {
              const nextMessage = e.target.value
              setMessage(nextMessage)
              setSelectedAgents((current) =>
                current.filter((agent) =>
                  resolveAgentTargetIds(nextMessage, connectedAgents, [
                    agent,
                  ]).includes(agent.id)
                )
              )
              setPickerDismissed(false)
              setPickerIndex(0)
            }}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
            placeholder="Message the room or @ an Agent…"
            aria-label="Message the room or @ an Agent"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={message.trim() === ""}
            className="rounded-lg bg-blue-600 p-2 transition hover:bg-blue-500 disabled:opacity-30"
            title="Send"
            aria-label="Send message"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-5 w-5 text-white"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
              />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      {artifactId && onReadArtifact && (
        <CollabArtifactViewer
          attachmentId={artifactId}
          read={onReadArtifact}
          onClose={() => setArtifactId(null)}
        />
      )}

      {resultTarget && onCollabResult && (
        <HumanCollabResultComposer
          requestId={resultTarget.requestId}
          status={resultTarget.status}
          maxLength={MAX_COLLAB_SUMMARY_LENGTH}
          onCancel={() => setResultTarget(null)}
          onSubmit={(summary) => {
            onCollabResult?.(
              resultTarget.requestId,
              resultTarget.status,
              summary
            )
            setResultTarget(null)
          }}
        />
      )}
    </>
  )
}
