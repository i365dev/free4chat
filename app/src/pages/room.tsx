import React, { useState, useEffect } from "react"

import dynamic from "next/dynamic"
import Head from "next/head"
import { useRouter } from "next/router"

import {
  randomName,
  saveRoomToLocalStorage,
  gtagEvent,
  umamiEvent,
  hashRoom,
} from "../common/utils"

const RoomContent = dynamic(() => import("../components/RoomContent"), {
  ssr: false,
})

export default function Room() {
  const router = useRouter()
  const roomId = router.query.id as string
  const roomTypeParam = router.query.type as string | undefined
  const [roomName, setRoomName] = useState<string>("")
  const [nickName, setNickName] = useState<string>("")
  const [roomType, setRoomType] = useState<"audio" | "screenshare">("audio")
  const [enableBot, setEnableBot] = useState<boolean>(false)
  const [showNickNamePop, setShowNickNamePop] = useState<boolean>(false)
  const [ready, setReady] = useState<boolean>(false)

  const dismissNickNamePop = () => {
    if (!nickName.trim()) return
    setShowNickNamePop(false)
    saveRoomToLocalStorage(roomName, nickName)
    setReady(true)
  }

  useEffect(() => {
    if (!router.isReady) return
    if (!roomId) {
      router.push("/")
      return
    }
    setRoomName(roomId)
    setRoomType(roomTypeParam === "screenshare" ? "screenshare" : "audio")
    if (typeof window !== "undefined") {
      setEnableBot(sessionStorage.getItem("enable_bot") === "1")
    }
    if (typeof window !== "undefined") {
      try {
        const rooms: { roomName: string; nickName: string }[] = JSON.parse(
          localStorage.getItem("rooms") || "[]"
        )
        const room = rooms.find((r) => r.roomName === roomId)
        if (room) {
          setNickName(room.nickName)
          setReady(true)
        } else {
          setShowNickNamePop(true)
        }
      } catch {
        setShowNickNamePop(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, roomId, roomTypeParam])

  useEffect(() => {
    if (ready && roomName && nickName) {
      gtagEvent("Room", "Join", roomType, 1)
      umamiEvent("Room", {
        type: "Join",
        roomHash: hashRoom(roomName),
        roomType,
      })
    }
  }, [ready, roomName, nickName, roomType])

  return (
    <div>
      <Head>
        <title>Room#{roomName} - Free4Chat</title>
      </Head>

      {showNickNamePop && (
        <main className="center h-screen w-auto bg-gray-900 text-center text-white">
          <div className="m-auto max-w-md rounded-lg bg-gray-800 p-8 shadow-2xl">
            <h2 className="text-lg font-bold">Input Your Nick Name</h2>
            <div className="relative mb-4 mt-4">
              <label htmlFor="nickname" className="sr-only">
                Nickname
              </label>
              <input
                type="text"
                id="nickname"
                value={nickName}
                placeholder="Nick Name"
                onChange={(e) => setNickName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") dismissNickNamePop()
                }}
                className="w-full rounded-md border-gray-200 bg-white p-3 text-gray-700 shadow-sm transition focus:border-white focus:outline-none focus:ring focus:ring-yellow-400"
              />
              <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                <button
                  onClick={() => setNickName(randomName())}
                  type="button"
                  className="text-black hover:bg-red-400"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-4 w-4"
                  >
                    <path d="M13 1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10zM3 0a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3H3z" />
                    <path d="M5.5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm4-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                  </svg>
                </button>
              </span>
            </div>
            <button
              type="button"
              onClick={dismissNickNamePop}
              disabled={!nickName.trim()}
              className="group mt-4 flex w-full items-center justify-center rounded-md bg-rose-600 px-5 py-3 text-white transition focus:outline-none focus:ring focus:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0 sm:w-auto"
            >
              <span className="text-sm font-medium"> Go </span>
              <svg
                className="ml-3 h-5 w-5"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M17 8l4 4m0 0l-4 4m4-4H3"
                />
              </svg>
            </button>
          </div>
        </main>
      )}

      {ready && roomName && nickName && (
        <RoomContent
          roomName={roomName}
          nickName={nickName}
          roomType={roomType}
          enableBot={enableBot}
        />
      )}
    </div>
  )
}
