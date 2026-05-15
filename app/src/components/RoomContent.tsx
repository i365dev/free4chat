import React, { useState } from "react"

import { useRouter } from "next/router"

import TextChatCard from "./TextChatCard"
import UserCard from "./UserCard"
import { useChatRoom } from "../hooks/useChatRoom"

export default function RoomContent({
  roomName,
  nickName,
}: {
  roomName: string
  nickName: string
}) {
  const router = useRouter()
  const [roomLinkCopied, setRoomLinkCopied] = useState(false)

  const {
    participants,
    messages,
    sendTextMessage,
    sendFileMessage,
    muteSelf,
    toggleScreenShare,
    error,
    expiryWarning,
    connectionStatus,
  } = useChatRoom(roomName, nickName)

  const copyRoomLink = () => {
    if (typeof window !== "undefined") {
      navigator.clipboard.writeText(
        window.location.origin + "/room?id=" + encodeURIComponent(roomName)
      )
      setRoomLinkCopied(true)
      setTimeout(() => setRoomLinkCopied(false), 2000)
    }
  }

  if (connectionStatus === "failed") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-white">
        <p className="mb-2 text-xl font-semibold text-gray-200">
          Connection lost
        </p>
        <p className="mb-6 text-sm text-gray-500">
          Could not reconnect after multiple attempts.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-rose-600 px-6 py-2 text-sm font-medium text-white hover:bg-rose-500 focus:outline-none focus:ring focus:ring-yellow-400"
        >
          Reload page
        </button>
      </main>
    )
  }

  if (connectionStatus === "connecting" && participants.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-16 w-16 animate-spin rounded-full border-4 border-gray-700 border-t-green-500" />
      </main>
    )
  }

  return (
    <main className="bg-gray-900 text-white" style={{ minHeight: "100vh" }}>
      {connectionStatus === "reconnecting" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60">
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-yellow-400" />
          <p className="text-sm text-gray-400">Reconnecting...</p>
        </div>
      )}
      <div className="flex items-center border-b border-gray-800 px-6 pb-4 pt-5">
        <h1 className="text-lg font-medium">#{roomName}</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={copyRoomLink}
            className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
            title="Copy room link"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            {roomLinkCopied ? "Copied!" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="mr-4 rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
          >
            Leave
          </button>
        </div>
      </div>

      {error !== "" && (
        <div
          className="flex items-center gap-4 rounded bg-gray-900 px-4 py-2 text-white"
          role="alert"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-amber-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <strong className="text-sm font-normal"> {error} </strong>
        </div>
      )}

      {expiryWarning !== "" && (
        <div
          className="mx-4 mt-2 flex items-center gap-4 rounded border border-amber-700/50 bg-amber-900/40 px-4 py-2 text-amber-200"
          role="alert"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 shrink-0 text-amber-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="text-sm">{expiryWarning}</span>
        </div>
      )}

      <div className="mx-auto min-h-screen px-8">
        <div className="flex flex-row flex-wrap justify-center sm:justify-start">
          {participants.map((p) => (
            <UserCard
              key={p.peerId}
              peerId={p.peerId}
              name={p.name}
              room={p.room}
              muteState={p.muteState}
              audioStream={p.audioStream}
              screenShareStream={p.screenShareStream}
              screenShareEnabled={p.screenShareEnabled}
              onMuteSelf={muteSelf}
              onToggleScreenShare={toggleScreenShare}
              className="sm:1/2 md:basis-1/8"
            />
          ))}
        </div>
        <TextChatCard
          room={roomName}
          messages={messages}
          onSendText={sendTextMessage}
          onSendFile={sendFileMessage}
        />
      </div>
    </main>
  )
}
