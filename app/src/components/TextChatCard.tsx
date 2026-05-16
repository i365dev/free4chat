import React, { useState, useRef, useEffect } from "react"

import Avatar from "boring-avatars"

import { LOCAL_PEER_ID } from "@common/consts"
import { ActionType, Message } from "@common/types"
import { strToBgColor, umamiEvent } from "@common/utils"

interface TextChatCardProps {
  room: string
  messages: Message[]
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

  if (msg.actionType === "vote") return null

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
  menuUp,
}: {
  onSelect: (gameId: string) => void
  onBack: () => void
  menuUp: boolean
}) {
  const posClass = menuUp
    ? "absolute bottom-10 left-0"
    : "absolute top-10 left-0"
  return (
    <div
      className={`${posClass} z-10 max-h-72 w-52 overflow-y-auto rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-xl`}
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
  )
}

export default function TextChatCard({
  room,
  messages,
  onSendText,
  onSendFile,
  onSendAction,
}: TextChatCardProps) {
  const [message, setMessage] = useState<string>("")
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [submenu, setSubmenu] = useState<"games" | null>(null)
  const [menuUp, setMenuUp] = useState<boolean>(true)
  const [showPollCreator, setShowPollCreator] = useState<boolean>(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const isComposingRef = useRef(false)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setSubmenu(null)
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [menuOpen])

  const closeMenu = () => {
    setMenuOpen(false)
    setSubmenu(null)
  }

  const handleSend = () => {
    if (message.trim() !== "") {
      onSendText(message.trim())
      setMessage("")
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
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
    umamiEvent("ChatAction", { type: "whiteboard", room })
    onSendAction("whiteboard", { url })
  }

  const handlePoll = () => {
    closeMenu()
    setShowPollCreator(true)
  }

  const handlePollSend = (question: string, options: string[]) => {
    setShowPollCreator(false)
    umamiEvent("ChatAction", { type: "poll", room })
    onSendAction("poll", {
      pollId: Date.now().toString(),
      question,
      options: options.join("||"),
    })
  }

  const handleGameSelect = (gameId: string) => {
    closeMenu()
    umamiEvent("ChatAction", { type: "game", gameId, room })
    onSendAction("game", { gameId })
  }

  const handleVote = (pollId: string, option: string) => {
    umamiEvent("ChatAction", { type: "vote", room })
    onSendAction("vote", { pollId, option })
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
            const isSelf = p.peerId === LOCAL_PEER_ID
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
                <div style={{ maxWidth: "72%" }}>
                  {!isSelf && (
                    <p className="mb-1 ml-1 text-xs text-gray-400">{p.name}</p>
                  )}
                  {p.type === "text" ? (
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
          <div ref={messagesEndRef} />
        </div>

        {showPollCreator && (
          <PollCreator
            onSend={handlePollSend}
            onCancel={() => setShowPollCreator(false)}
          />
        )}

        <div className="relative flex flex-none items-center gap-2 border-t border-gray-700 p-3">
          <div ref={menuRef} className="relative">
            <button
              ref={menuBtnRef}
              type="button"
              onClick={() => {
                const btn = menuBtnRef.current
                if (btn) {
                  const rect = btn.getBoundingClientRect()
                  setMenuUp(rect.top > 240)
                }
                setMenuOpen((v) => !v)
                setSubmenu(null)
              }}
              className="rounded-lg bg-gray-700 p-2 transition hover:bg-gray-600"
              title="More actions"
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
                  d="M12 4.5v15m7.5-7.5h-15"
                />
              </svg>
            </button>

            {menuOpen && !submenu && (
              <div
                className={`absolute ${
                  menuUp ? "bottom-10" : "top-10"
                } left-0 z-10 w-44 rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-xl`}
              >
                <button
                  type="button"
                  onClick={handleWhiteboard}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700"
                >
                  <span>📋</span>
                  <span>Whiteboard</span>
                </button>
                <button
                  type="button"
                  onClick={handlePoll}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700"
                >
                  <span>📊</span>
                  <span>Poll</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSubmenu("games")}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm text-gray-200 hover:bg-gray-700"
                >
                  <span className="flex items-center gap-2">
                    <span>🎮</span>
                    <span>Games</span>
                  </span>
                  <span className="text-gray-500">›</span>
                </button>
              </div>
            )}

            {menuOpen && submenu === "games" && (
              <GamesMenu
                onSelect={handleGameSelect}
                onBack={() => setSubmenu(null)}
                menuUp={menuUp}
              />
            )}
          </div>

          <input
            className="flex-1 rounded-xl bg-gray-900"
            type="text"
            value={message}
            onKeyDown={handleKeyDown}
            onChange={(e) => setMessage(e.target.value)}
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
