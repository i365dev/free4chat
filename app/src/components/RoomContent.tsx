import React from "react"

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
  const {
    participants,
    messages,
    sendTextMessage,
    sendFileMessage,
    muteSelf,
    toggleScreenShare,
    error,
  } = useChatRoom(roomName, nickName)

  if (participants.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-16 w-16 animate-spin rounded-full border-4 border-gray-700 border-t-green-500" />
      </main>
    )
  }

  return (
    <main className="bg-gray-900 text-white" style={{ minHeight: "100vh" }}>
      <div className="mb-5 ml-10 pt-5">
        <h1 className="text-lg font-medium">#{roomName}</h1>
      </div>

      {error !== "" && (
        <div
          className="flex items-center gap-4 rounded bg-gray-900 px-4 text-white"
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
