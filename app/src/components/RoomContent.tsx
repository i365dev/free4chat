import React, { useState, useEffect, useRef } from "react"

import { useRouter } from "next/router"

import { LOCAL_PEER_ID } from "@common/consts"

import TextChatCard from "./TextChatCard"
import UserCard from "./UserCard"
import { umamiEvent, hashRoom, participantsBucket } from "../common/utils"
import { useChatRoom } from "../hooks/useChatRoom"

function ScreenShareViewer({
  stream,
  name,
}: {
  stream: MediaStream
  name: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

  const enterFullscreen = () => {
    const v = videoRef.current
    if (!v) return
    if (v.requestFullscreen) v.requestFullscreen()
    else if ((v as any).webkitEnterFullscreen)
      (v as any).webkitEnterFullscreen()
  }

  return (
    <div
      className={`relative flex-none border-b border-gray-800 bg-black ${
        expanded ? "h-96" : "h-48"
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full cursor-pointer object-contain"
        onClick={() => setExpanded((v) => !v)}
      />
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {name}
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1">
        <button
          className="rounded bg-black/60 p-1 text-white hover:bg-black/80"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Shrink" : "Expand"}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            {expanded ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 9V4m0 0H4m5 0L3 10m12-1V4m0 0h5m-5 0l6 6M9 15v5m0 0H4m5 0l-6-6m12 6v-5m0 5h5m-5 0l6-6"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"
              />
            )}
          </svg>
        </button>
        <button
          className="rounded bg-black/60 p-1 text-white hover:bg-black/80"
          onClick={enterFullscreen}
          title="Fullscreen"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default function RoomContent({
  roomName,
  nickName,
  roomType,
}: {
  roomName: string
  nickName: string
  roomType: "audio" | "screenshare"
}) {
  const router = useRouter()
  const [roomLinkCopied, setRoomLinkCopied] = useState(false)

  const {
    participants,
    messages,
    sendTextMessage,
    sendFileMessage,
    sendActionMessage,
    muteSelf,
    toggleScreenShare,
    error,
    expiryWarning,
    connectionStatus,
    resolvedRoomType,
  } = useChatRoom(roomName, nickName, roomType)

  const screenshareAllowed = resolvedRoomType === "screenshare"

  const activeScreenShares = participants.filter(
    (p) =>
      p.screenShareEnabled && p.peerId !== LOCAL_PEER_ID && p.screenShareStream
  )

  const lastBucketRef = useRef<string>("")
  useEffect(() => {
    const bucket = participantsBucket(participants.length)
    if (bucket !== lastBucketRef.current) {
      lastBucketRef.current = bucket
      umamiEvent("RoomSize", {
        roomHash: hashRoom(roomName),
        bucket,
        roomType: resolvedRoomType,
      })
    }
  }, [participants.length, roomName, resolvedRoomType])

  const hasSentTextRef = useRef(false)
  const wrappedSendText = (text: string) => {
    if (!hasSentTextRef.current) {
      hasSentTextRef.current = true
      umamiEvent("ChatActivity", { type: "text", roomHash: hashRoom(roomName) })
    }
    sendTextMessage(text)
  }

  const wrappedSendFile = (file: File) => {
    umamiEvent("ChatActivity", {
      type: file.type.startsWith("image/") ? "image" : "file",
      roomHash: hashRoom(roomName),
    })
    sendFileMessage(file)
  }

  const copyRoomLink = () => {
    if (typeof window !== "undefined") {
      const url =
        window.location.origin +
        "/room?id=" +
        encodeURIComponent(roomName) +
        (resolvedRoomType === "screenshare" ? "&type=screenshare" : "")
      navigator.clipboard.writeText(url)
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
    <main className="flex h-screen flex-col overflow-hidden bg-gray-900 text-white">
      {connectionStatus === "reconnecting" && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60">
          <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-gray-700 border-t-yellow-400" />
          <p className="text-sm text-gray-400">Reconnecting...</p>
        </div>
      )}

      <div className="flex flex-none items-center border-b border-gray-800 px-4 py-3">
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
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
          >
            Leave
          </button>
        </div>
      </div>

      {error !== "" && (
        <div
          className="flex flex-none items-center gap-4 bg-gray-900 px-4 py-2 text-white"
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
          className="mx-4 mt-1 flex flex-none items-center gap-4 rounded border border-amber-700/50 bg-amber-900/40 px-4 py-2 text-amber-200"
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

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="scrollbar-thin flex flex-none flex-row gap-2 overflow-x-auto border-b border-gray-800 p-2 md:w-52 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-r md:p-3">
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
              screenshareAllowed={screenshareAllowed}
              className="w-20 flex-shrink-0 md:w-full md:flex-shrink"
              compact
            />
          ))}
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">
          {activeScreenShares.map((p) => (
            <ScreenShareViewer
              key={p.peerId}
              stream={p.screenShareStream!}
              name={p.name}
            />
          ))}
          <TextChatCard
            room={roomName}
            messages={messages}
            onSendText={wrappedSendText}
            onSendFile={wrappedSendFile}
            onSendAction={sendActionMessage}
          />
        </div>
      </div>
    </main>
  )
}
