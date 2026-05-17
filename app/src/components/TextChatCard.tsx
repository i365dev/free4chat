import React, { useState, useRef, useEffect } from "react"

import Avatar from "boring-avatars"

import { LOCAL_PEER_ID } from "@common/consts"
import { ActionType, Message } from "@common/types"
import { strToBgColor, umamiEvent, hashRoom } from "@common/utils"

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
  pendingFiles?: PendingFile[]
  botEnabled?: boolean
  botThinking?: boolean
  botError?: string
  onSendText: (text: string) => void
  onSendFile: (file: File) => void
  onSendAction: (
    actionType: ActionType,
    actionPayload: Record<string, string>
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

function TextWithLinks({ text }: { text: string }) {
  const urlRegex = /(https?:\/\/[^\s]+)/g
  const parts = text.split(urlRegex)
  return (
    <span className="break-all">
      {parts.map((part, i) =>
        urlRegex.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="underline opacity-90 hover:opacity-100"
          >
            {part}
          </a>
        ) : (
          part
        )
      )}
    </span>
  )
}

function BotText({ text }: { text: string }) {
  const urlRegex = /(https?:\/\/[^\s]+)/g
  const boldRegex = /\*\*(.+?)\*\*/g
  const codeRegex = /`([^`]+)`/g

  function renderInline(segment: string, keyPrefix: string) {
    const parts: React.ReactNode[] = []
    let remaining = segment
    let i = 0

    while (remaining.length > 0) {
      const boldMatch = boldRegex.exec(remaining)
      const codeMatch = codeRegex.exec(remaining)
      const urlMatch = urlRegex.exec(remaining)

      boldRegex.lastIndex = 0
      codeRegex.lastIndex = 0
      urlRegex.lastIndex = 0

      const matches = [
        boldMatch && {
          idx: boldMatch.index,
          len: boldMatch[0].length,
          type: "bold",
          content: boldMatch[1],
        },
        codeMatch && {
          idx: codeMatch.index,
          len: codeMatch[0].length,
          type: "code",
          content: codeMatch[1],
        },
        urlMatch && {
          idx: urlMatch.index,
          len: urlMatch[0].length,
          type: "url",
          content: urlMatch[0],
        },
      ]
        .filter(Boolean)
        .sort((a, b) => a!.idx - b!.idx)

      const first = matches[0]
      if (!first) {
        parts.push(remaining)
        break
      }

      if (first.idx > 0) parts.push(remaining.slice(0, first.idx))

      if (first.type === "bold") {
        parts.push(
          <strong key={`${keyPrefix}-b${i++}`}>{first.content}</strong>
        )
      } else if (first.type === "code") {
        parts.push(
          <code
            key={`${keyPrefix}-c${i++}`}
            className="rounded bg-violet-800/60 px-1 font-mono text-xs"
          >
            {first.content}
          </code>
        )
      } else {
        parts.push(
          <a
            key={`${keyPrefix}-u${i++}`}
            href={first.content}
            target="_blank"
            rel="noopener noreferrer"
            className="underline opacity-90 hover:opacity-100"
          >
            {first.content}
          </a>
        )
      }

      remaining = remaining.slice(first.idx + first.len)
    }

    return parts
  }

  const lines = text.split("\n")
  return (
    <span className="break-words">
      {lines.map((line, li) => (
        <span key={li}>
          {renderInline(line, `l${li}`)}
          {li < lines.length - 1 && <br />}
        </span>
      ))}
    </span>
  )
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
}: {
  msg: Message
  isSelf: boolean
  allMessages: Message[]
  myPeerId: string
  onVote: (pollId: string, option: string) => void
}) {
  if (msg.actionType === "reaction") return null

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
  pendingFiles = [],
  botEnabled = false,
  botThinking = false,
  botError = "",
  onSendText,
  onSendFile,
  onSendAction,
}: TextChatCardProps) {
  const [message, setMessage] = useState<string>("")
  const [submenu, setSubmenu] = useState<"games" | null>(null)
  const [showPollCreator, setShowPollCreator] = useState<boolean>(false)
  const [pickerIndex, setPickerIndex] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const gamesBtnRef = useRef<HTMLDivElement>(null)
  const gamesMenuRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, pendingFiles])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const inBtn = gamesBtnRef.current?.contains(e.target as Node)
      const inMenu = gamesMenuRef.current?.contains(e.target as Node)
      if (!inBtn && !inMenu) {
        setSubmenu(null)
      }
    }
    if (submenu) document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [submenu])

  const closeMenu = () => {
    setSubmenu(null)
  }

  const handleSend = () => {
    if (message.trim() !== "") {
      onSendText(message.trim())
      setMessage("")
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (showPicker) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setPickerIndex((i) => (i + 1) % pickerItems.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setPickerIndex((i) => (i - 1 + pickerItems.length) % pickerItems.length)
        return
      }
      if (event.key === "Enter" && !isComposingRef.current) {
        event.preventDefault()
        commitPicker(pickerIndex)
        return
      }
      if (event.key === "Escape") {
        setMessage("")
        setPickerIndex(0)
        return
      }
    }
    if (
      event.key === "Enter" &&
      !isComposingRef.current &&
      message.trim() !== ""
    ) {
      onSendText(message.trim())
      setMessage("")
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
    ...(botEnabled
      ? [
          {
            icon: "🤖",
            label: "/luna",
            desc: "Ask Luna AI",
            action: () => {
              setMessage("@luna ")
              inputRef.current?.focus()
            },
          },
        ]
      : []),
  ]

  const atMentions = botEnabled
    ? [
        {
          icon: "🤖",
          label: "@luna",
          desc: "Ask Luna AI",
          action: () => {
            setMessage("@luna ")
            inputRef.current?.focus()
          },
        },
      ]
    : []

  const pickerItems =
    message === "/"
      ? slashCommands
      : message.startsWith("/") && !message.includes(" ")
      ? slashCommands.filter((c) => c.label.startsWith(message.toLowerCase()))
      : message.startsWith("@") && !message.includes(" ")
      ? atMentions.filter((m) => m.label.startsWith(message.toLowerCase()))
      : []

  const showPicker = pickerItems.length > 0

  const commitPicker = (idx: number) => {
    pickerItems[idx]?.action()
    setPickerIndex(0)
  }

  return (
    <>
      <style>{`
      .scrollbar-thin::-webkit-scrollbar { width: 4px; }
      .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
      .scrollbar-thin::-webkit-scrollbar-thumb { background: #374151; border-radius: 9999px; }
      .scrollbar-thin::-webkit-scrollbar-thumb:hover { background: #4b5563; }
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
            const isBot = p.type === "bot"
            return (
              <div
                className={`mb-4 flex w-full items-end ${
                  isSelf && !isBot ? "flex-row-reverse" : "flex-row"
                }`}
                key={i}
              >
                <div
                  className={`flex-shrink-0 ${
                    isSelf && !isBot ? "ml-2" : "mr-2"
                  }`}
                >
                  {isBot ? (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-700 text-sm">
                      🤖
                    </div>
                  ) : (
                    <Avatar size={28} variant="beam" name={p.name} />
                  )}
                </div>
                <div style={{ maxWidth: "72%" }}>
                  {!isSelf && (
                    <p className="mb-1 ml-1 text-xs text-gray-400">{p.name}</p>
                  )}
                  {isBot ? (
                    <div className="rounded-br-3xl rounded-tl-xl rounded-tr-3xl bg-violet-900/60 px-4 py-3 text-violet-100 ring-1 ring-violet-700/50">
                      <BotText text={p.text ?? ""} />
                    </div>
                  ) : p.type === "text" ? (
                    <div
                      className={
                        isSelf
                          ? "rounded-bl-3xl rounded-tl-3xl rounded-tr-xl bg-blue-600 px-4 py-3 text-white"
                          : "rounded-br-3xl rounded-tl-xl rounded-tr-3xl px-4 py-3"
                      }
                      style={
                        isSelf
                          ? undefined
                          : { backgroundColor: strToBgColor(p.name) }
                      }
                    >
                      <TextWithLinks text={p.text ?? ""} />
                    </div>
                  ) : p.type === "action" ? (
                    <ActionCard
                      msg={p}
                      isSelf={isSelf}
                      allMessages={messages}
                      myPeerId={LOCAL_PEER_ID}
                      onVote={handleVote}
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
          {botThinking && (
            <div className="mb-4 flex w-full flex-row items-end">
              <div className="mr-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-violet-700 text-sm">
                🤖
              </div>
              <div className="rounded-br-3xl rounded-tl-xl rounded-tr-3xl bg-violet-900/60 px-4 py-3 ring-1 ring-violet-700/50">
                <span className="inline-flex gap-1 text-violet-400">
                  <span className="animate-bounce [animation-delay:0ms]">
                    ·
                  </span>
                  <span className="animate-bounce [animation-delay:150ms]">
                    ·
                  </span>
                  <span className="animate-bounce [animation-delay:300ms]">
                    ·
                  </span>
                </span>
              </div>
            </div>
          )}
          {botError && (
            <div className="mb-4 flex w-full flex-row items-end">
              <div className="mr-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-violet-700/40 text-sm">
                🤖
              </div>
              <div className="rounded-br-3xl rounded-tl-xl rounded-tr-3xl bg-red-900/40 px-4 py-2 text-xs text-red-300 ring-1 ring-red-700/40">
                {botError}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {showPollCreator && (
          <PollCreator
            onSend={handlePollSend}
            onCancel={() => setShowPollCreator(false)}
          />
        )}

        <div className="relative border-t border-gray-700 px-3 pb-1 pt-2">
          <div
            className="flex items-center gap-1.5 overflow-x-auto"
            style={{ scrollbarWidth: "none" }}
          >
            <button
              type="button"
              onClick={handleWhiteboard}
              className="flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-600 bg-gray-800 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:bg-gray-700 hover:text-white"
            >
              <span>🎨</span>
              <span>Draw</span>
            </button>

            <button
              type="button"
              onClick={handlePoll}
              className="flex items-center gap-1 whitespace-nowrap rounded-full border border-gray-600 bg-gray-800 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:bg-gray-700 hover:text-white"
            >
              <span>📊</span>
              <span>Poll</span>
            </button>

            <div ref={gamesBtnRef} className="relative">
              <button
                type="button"
                onClick={() =>
                  setSubmenu((v) => (v === "games" ? null : "games"))
                }
                className={`flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  submenu === "games"
                    ? "border-gray-400 bg-gray-700 text-white"
                    : "border-gray-600 bg-gray-800 text-gray-300 hover:border-gray-500 hover:bg-gray-700 hover:text-white"
                }`}
              >
                <span>🎮</span>
                <span>Games</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                  stroke="currentColor"
                  className="h-2.5 w-2.5 opacity-50"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                  />
                </svg>
              </button>
            </div>

            {botEnabled ? (
              <button
                type="button"
                onClick={() => {
                  setMessage((prev) =>
                    prev.includes("@luna") ? prev : prev + "@luna "
                  )
                  inputRef.current?.focus()
                }}
                title="Mention Luna"
                className="flex items-center gap-1 whitespace-nowrap rounded-full border border-violet-600 bg-violet-900/40 px-2.5 py-1 text-xs text-violet-300 transition-colors hover:border-violet-400 hover:bg-violet-800/50"
              >
                <span>🤖</span>
                <span>Luna</span>
                <span className="rounded-full bg-violet-700/60 px-1 py-0 text-[9px] leading-tight text-violet-300">
                  @luna
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="AI companion — enable when creating a room"
                className="flex cursor-not-allowed items-center gap-1 whitespace-nowrap rounded-full border border-gray-600 bg-gray-800 px-2.5 py-1 text-xs text-gray-300 opacity-40"
              >
                <span>🤖</span>
                <span>Luna</span>
                <span className="rounded-full bg-gray-700 px-1 py-0 text-[9px] leading-tight text-gray-500">
                  off
                </span>
              </button>
            )}
          </div>

          {submenu === "games" && (
            <GamesMenu
              onSelect={handleGameSelect}
              onBack={() => setSubmenu(null)}
              menuRef={gamesMenuRef}
            />
          )}
        </div>

        <div className="relative flex flex-none items-center gap-2 border-t border-gray-700 p-3">
          {showPicker && (
            <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-gray-600 bg-gray-800 shadow-xl">
              {pickerItems.map((item, i) => (
                <button
                  key={item.label}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commitPicker(i)
                  }}
                  onTouchEnd={(e) => {
                    e.preventDefault()
                    commitPicker(i)
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                    i === pickerIndex
                      ? "bg-gray-700 text-white"
                      : "text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  <span className="font-medium">{item.label}</span>
                  <span className="text-xs text-gray-500">{item.desc}</span>
                </button>
              ))}
            </div>
          )}
          <input
            ref={inputRef}
            className="flex-1 rounded-xl bg-gray-900"
            type="text"
            value={message}
            onKeyDown={handleKeyDown}
            onChange={(e) => {
              setMessage(e.target.value)
              setPickerIndex(0)
            }}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
            placeholder="type your message here..."
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={message.trim() === ""}
            className="rounded-lg bg-blue-600 p-2 transition hover:bg-blue-500 disabled:opacity-30"
            title="Send"
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-gray-700 p-2 transition hover:bg-gray-600"
            title="Send file"
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
                d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"
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
    </>
  )
}
