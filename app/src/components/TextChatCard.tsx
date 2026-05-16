import React, { useState, useRef, useEffect } from "react"

import { LOCAL_PEER_ID } from "@common/consts"
import { ActionType, Message } from "@common/types"
import { strToBgColor } from "@common/utils"

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

function ActionCard({ msg, isSelf }: { msg: Message; isSelf: boolean }) {
  const containerClass = isSelf
    ? "mr-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3"
    : "ml-2 rounded-br-3xl rounded-tr-3xl rounded-tl-xl px-4 py-3"

  if (msg.actionType === "whiteboard") {
    const url = msg.actionPayload?.url ?? ""
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
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
            />
          </svg>
          <span className="text-sm font-medium">📋 Open Whiteboard</span>
        </a>
      </div>
    )
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

export default function TextChatCard({
  room,
  messages,
  onSendText,
  onSendFile,
  onSendAction,
}: TextChatCardProps) {
  const [message, setMessage] = useState<string>("")
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [menuOpen])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && message.trim() !== "") {
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
    setMenuOpen(false)
    const url = getOrCreateWhiteboardUrl(room)
    onSendAction("whiteboard", { url })
  }

  return (
    <>
      <style>{`
      .scrollbar-thin::-webkit-scrollbar { width: 4px; }
      .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
      .scrollbar-thin::-webkit-scrollbar-thumb { background: #374151; border-radius: 9999px; }
      .scrollbar-thin::-webkit-scrollbar-thumb:hover { background: #4b5563; }
    `}</style>
      <div className="mt-4 block rounded-xl border border-gray-700 bg-gray-800 p-4 shadow-xl">
        {messages.length > 0 && (
          <div className="scrollbar-thin flex max-h-96 w-full flex-col justify-between overflow-y-auto text-sm">
            <div className="mt-5 flex flex-col-reverse">
              <div ref={messagesEndRef} />
              {messages.map((p, i) => {
                const isSelf = p.peerId === LOCAL_PEER_ID
                return (
                  <div className="mb-4 flex w-full" key={i}>
                    <div
                      className={isSelf ? "ml-auto" : "mr-auto"}
                      style={{ maxWidth: "70%" }}
                    >
                      {p.type === "text" ? (
                        <div
                          className={
                            isSelf
                              ? "mr-2 rounded-bl-3xl rounded-tl-3xl rounded-tr-xl px-4 py-3"
                              : "ml-2 rounded-br-3xl rounded-tl-xl rounded-tr-3xl px-4 py-3"
                          }
                          style={{ backgroundColor: strToBgColor(p.name) }}
                        >
                          <TextWithLinks text={p.text ?? ""} />
                        </div>
                      ) : p.type === "action" ? (
                        <ActionCard msg={p} isSelf={isSelf} />
                      ) : (
                        <FileMessageBubble msg={p} isSelf={isSelf} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="relative mt-2 flex items-center gap-2">
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
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
            {menuOpen && (
              <div className="absolute bottom-10 left-0 z-10 w-44 rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-xl">
                <button
                  type="button"
                  onClick={handleWhiteboard}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700"
                >
                  <span>📋</span>
                  <span>Whiteboard</span>
                </button>
              </div>
            )}
          </div>

          <input
            className="flex-1 rounded-xl bg-gray-900"
            type="text"
            value={message}
            onKeyDown={handleKeyDown}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="type your message here..."
          />
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
