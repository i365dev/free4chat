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
    <div className="relative min-h-0 flex-1 bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-contain"
      />
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
        {name}
      </div>
      <button
        className="absolute bottom-2 right-2 rounded bg-black/60 p-1 text-white hover:bg-black/80"
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
  const [pendingFiles, setPendingFiles] = useState<
    { id: string; fileName: string; isImage: boolean; error?: boolean }[]
  >([])

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

  const [activeSharePeerId, setActiveSharePeerId] = useState<string | null>(
    null
  )
  useEffect(() => {
    if (activeScreenShares.length === 0) {
      setActiveSharePeerId(null)
      return
    }
    if (
      !activeSharePeerId ||
      !activeScreenShares.find((p) => p.peerId === activeSharePeerId)
    ) {
      setActiveSharePeerId(activeScreenShares[0].peerId)
    }
  }, [activeScreenShares, activeSharePeerId])
  const activeShare =
    activeScreenShares.find((p) => p.peerId === activeSharePeerId) ??
    activeScreenShares[0] ??
    null

  const containerRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const [splitRatio, setSplitRatio] = useState(50)
  const [isMd, setIsMd] = useState(false)

  useEffect(() => {
    const check = () => setIsMd(window.innerWidth >= 768)
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [])

  useEffect(() => {
    setSplitRatio(activeScreenShares.length > 0 ? 75 : 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreenShares.length > 0])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const ratio = ((e.clientX - rect.left) / rect.width) * 100
      setSplitRatio(Math.max(20, Math.min(80, ratio)))
    }
    const onMouseUp = () => {
      isDragging.current = false
    }
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, [])

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

  const MAX_FILE_SIZE = 10 * 1024 * 1024

  const wrappedSendFile = async (file: File) => {
    const id = `${Date.now()}-${file.name}`
    if (file.size > MAX_FILE_SIZE) {
      setPendingFiles((prev) => [
        ...prev,
        {
          id,
          fileName: file.name,
          isImage: file.type.startsWith("image/"),
          error: true,
          errorMessage: `File too large (max 10 MB)`,
        },
      ])
      setTimeout(
        () => setPendingFiles((prev) => prev.filter((f) => f.id !== id)),
        3000
      )
      return
    }
    umamiEvent("ChatActivity", {
      type: file.type.startsWith("image/") ? "image" : "file",
      roomHash: hashRoom(roomName),
    })
    setPendingFiles((prev) => [
      ...prev,
      { id, fileName: file.name, isImage: file.type.startsWith("image/") },
    ])
    try {
      await sendFileMessage(file)
    } catch {
      setPendingFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? { ...f, error: true, errorMessage: "Failed to send" }
            : f
        )
      )
      setTimeout(
        () => setPendingFiles((prev) => prev.filter((f) => f.id !== id)),
        3000
      )
      return
    }
    setPendingFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const selfScreenShareRef = useRef(false)
  const wrappedToggleScreenShare = () => {
    const isCurrentlySharing = participants.find(
      (p) => p.peerId === LOCAL_PEER_ID
    )?.screenShareEnabled
    selfScreenShareRef.current = !isCurrentlySharing
    umamiEvent("ScreenShare", {
      action: isCurrentlySharing ? "stop" : "start",
      roomHash: hashRoom(roomName),
    })
    toggleScreenShare()
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
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
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

      <div
        ref={containerRef}
        className="flex flex-1 flex-col overflow-hidden md:flex-row"
      >
        <div
          className="flex flex-1 flex-col overflow-hidden border-b border-gray-800 md:flex-none md:border-b-0 md:border-r"
          style={isMd ? { width: `${splitRatio}%` } : undefined}
        >
          {activeScreenShares.length > 0 ? (
            <>
              {activeShare && (
                <ScreenShareViewer
                  key={activeShare.peerId}
                  stream={activeShare.screenShareStream!}
                  name={activeShare.name}
                />
              )}
              <div className="scrollbar-thin flex flex-none flex-row gap-2 overflow-x-auto border-t border-gray-800 p-2">
                {participants.map((p) => (
                  <div
                    key={p.peerId}
                    className={`flex-shrink-0 rounded-xl transition-all ${
                      p.screenShareEnabled &&
                      p.peerId !== LOCAL_PEER_ID &&
                      p.peerId === activeSharePeerId
                        ? "ring-2 ring-blue-400"
                        : ""
                    } ${
                      p.screenShareEnabled && p.peerId !== LOCAL_PEER_ID
                        ? "cursor-pointer"
                        : ""
                    }`}
                    onClick={() => {
                      if (p.screenShareEnabled && p.peerId !== LOCAL_PEER_ID) {
                        setActiveSharePeerId(p.peerId)
                      }
                    }}
                  >
                    <UserCard
                      peerId={p.peerId}
                      name={p.name}
                      room={p.room}
                      muteState={p.muteState}
                      audioStream={p.audioStream}
                      screenShareStream={p.screenShareStream}
                      screenShareEnabled={p.screenShareEnabled}
                      onMuteSelf={muteSelf}
                      onToggleScreenShare={wrappedToggleScreenShare}
                      screenshareAllowed={screenshareAllowed}
                      className="w-20"
                      compact
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="scrollbar-thin flex h-full flex-wrap content-start items-start gap-2 overflow-y-auto p-3">
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
                  onToggleScreenShare={wrappedToggleScreenShare}
                  screenshareAllowed={screenshareAllowed}
                  className="w-40 flex-none"
                />
              ))}
            </div>
          )}
        </div>

        <div
          className="hidden w-1 cursor-col-resize bg-gray-800 transition-colors hover:bg-blue-500/50 active:bg-blue-500 md:block"
          onMouseDown={(e) => {
            isDragging.current = true
            e.preventDefault()
          }}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <TextChatCard
            room={roomName}
            nickName={nickName}
            messages={messages}
            pendingFiles={pendingFiles}
            onSendText={wrappedSendText}
            onSendFile={wrappedSendFile}
            onSendAction={sendActionMessage}
          />
        </div>
      </div>
    </main>
  )
}
