import React, { useState, useEffect, useCallback } from "react"

import Head from "next/head"
import { useRouter } from "next/router"
import { Audio } from "react-loader-spinner"
import { RealtimeKitProvider } from "@cloudflare/realtimekit-react"

import { UserInfo, Message } from "../common/types"
import { randomName, saveRoomToLocalStorage, gtagEvent, umamiEvent } from "../common/utils"
import TextChatCard from "../components/TextChatCard"
import UserCard from "../components/UserCard"
import { useChatRoom } from "../hooks/useChatRoom"

function RoomContent({ roomName, nickName }: { roomName: string; nickName: string }) {
  const { participants, messages, sendTextMessage, sendFileMessage, muteSelf, error } =
    useChatRoom(roomName, nickName)

  return (
    <div>
      {participants.length <= 0 && (
        <main className="center h-screen w-auto bg-gray-900 text-center text-white">
          <Audio
            height="200"
            width="200"
            color="#4fa94d"
            ariaLabel="audio-loading"
            wrapperStyle={{}}
            wrapperClass="loader pt-40"
            visible={true}
          />
        </main>
      )}
      {participants.length > 0 && (
        <main className="bg-gray-900 text-white">
          <div className="ml-10 mb-5 pt-5">
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
                  onMuteSelf={muteSelf}
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
      )}
    </div>
  )
}

export default function Room() {
  const router = useRouter()
  const roomId = router.query.id as string
  const [roomName, setRoomName] = useState<string>("")
  const [nickName, setNickName] = useState<string>("")
  const [showNickNamePop, setShowNickNamePop] = useState<boolean>(false)
  const [ready, setReady] = useState<boolean>(false)

  const dismissNickNamePop = () => {
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
    if (typeof window !== "undefined") {
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
    }
  }, [router.isReady, roomId])

  useEffect(() => {
    if (ready && roomName && nickName) {
      gtagEvent("Room", roomName, nickName, "JoinSuccess")
      umamiEvent("Room", { type: "Join", message: "Success", user: nickName, room: roomName })
    }
  }, [ready, roomName, nickName])

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
              className="group mt-4 flex w-full items-center justify-center rounded-md bg-rose-600 px-5 py-3 text-white transition focus:outline-none focus:ring focus:ring-yellow-400 sm:mt-0 sm:w-auto"
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
        <RealtimeKitProvider value={null}>
          <RoomContent roomName={roomName} nickName={nickName} />
        </RealtimeKitProvider>
      )}
    </div>
  )
}
