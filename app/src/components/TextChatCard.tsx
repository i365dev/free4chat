import React, { useState, useRef } from "react"

import { LOCAL_PEER_ID } from "@common/consts"
import { Message } from "@common/types"
import { strToBgColor } from "@common/utils"

interface TextChatCardProps {
  room: string
  messages: Message[]
  onSendText: (text: string) => void
  onSendFile: (file: File) => void
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
            className="max-h-40 max-w-xs rounded"
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
}: TextChatCardProps) {
  const [message, setMessage] = useState<string>("")
  const fileInputRef = useRef<HTMLInputElement>(null)

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
                          {p.text}
                        </div>
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

        <div className="mt-2 flex items-center gap-2">
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
