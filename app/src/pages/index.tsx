import { useState, useEffect } from "react"

import { useRouter } from "next/router"

import { randomName, saveRoomToLocalStorage } from "../common/utils"
import Header from "../components/Header"

export default function Home() {
  const router = useRouter()
  const [roomName, setRoomName] = useState<string>("")
  const [nickName, setNickName] = useState<string>("")
  const [copied, setCopied] = useState<boolean>(false)

  useEffect(() => {
    setRoomName(randomName())
  }, [])

  const go = () => {
    if (roomName !== "" && nickName != "") {
      if (typeof window !== "undefined") {
        saveRoomToLocalStorage(roomName, nickName)
      }
      router.push("/room?id=" + roomName)
    }
  }

  const copyRoomLink = () => {
    if (typeof window !== "undefined" && roomName) {
      navigator.clipboard.writeText(
        window.location.origin + "/room?id=" + roomName
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div>
      <Header></Header>
      <main className="bg-gray-900 text-white">
        <div className="mx-auto h-screen max-w-screen-xl px-4 py-32 lg:flex lg:items-center">
          <div className="slogan mx-auto max-w-3xl text-center">
            <h1 className="bg-gradient-to-r from-green-300 via-blue-500 to-purple-600 bg-clip-text text-3xl font-extrabold text-transparent sm:text-4xl">
              Open a room. Talk instantly.
            </h1>

            <p className="mx-auto mt-4 text-gray-400 sm:text-sm sm:leading-relaxed">
              No sign-up. No history. Close the tab and it&apos;s gone.
            </p>

            <div className="mx-auto mt-8 max-w-xl">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="relative flex-1">
                  <label htmlFor="room" className="sr-only">
                    Room
                  </label>

                  <input
                    type="input"
                    id="room"
                    placeholder="Room Name"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    className="w-full rounded-md border border-gray-600 bg-gray-800 p-3 text-white placeholder-gray-400 shadow-sm transition focus:border-white focus:outline-none focus:ring focus:ring-yellow-400"
                  />

                  <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                    <button
                      onClick={() => setRoomName(randomName())}
                      type="button"
                      className="text-gray-400 hover:text-yellow-400"
                      title="Randomize room name"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="h-4 w-4"
                      >
                        <path d="M13 1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10zM3 0a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3H3z" />{" "}
                        <path d="M5.5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm4-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                      </svg>
                    </button>
                  </span>
                </div>

                <div className="relative flex-1">
                  <label htmlFor="nickname" className="sr-only">
                    Nickname
                  </label>

                  <input
                    type="input"
                    id="nickname"
                    value={nickName}
                    placeholder="Nick Name"
                    onChange={(e) => setNickName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") go()
                    }}
                    className="w-full rounded-md border border-gray-600 bg-gray-800 p-3 text-white placeholder-gray-400 shadow-sm transition focus:border-white focus:outline-none focus:ring focus:ring-yellow-400"
                  />

                  <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                    <button
                      onClick={() => setNickName(randomName())}
                      type="button"
                      className="text-gray-400 hover:text-yellow-400"
                      title="Randomize nickname"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="h-4 w-4"
                      >
                        <path d="M13 1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10zM3 0a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3H3z" />{" "}
                        <path d="M5.5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm4-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                      </svg>
                    </button>
                  </span>
                </div>

                <button
                  type="button"
                  onClick={go}
                  className="group flex w-full items-center justify-center rounded-md bg-rose-600 px-5 py-3 text-white transition focus:outline-none focus:ring focus:ring-yellow-400 sm:w-auto"
                >
                  <span className="text-sm font-medium"> Join </span>

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

              {roomName && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copyRoomLink}
                    className="flex items-center gap-1 rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
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
                    {copied ? "Copied!" : "Copy link"}
                  </button>
                </div>
              )}
            </div>

            <p className="mt-8 text-center text-xs text-gray-600">
              This website will collect some runtime technical data for
              debugging, using at your risk.
            </p>
            <p className="mt-3 text-center text-xs text-gray-600">
              Powered by{" "}
              <a
                href="https://www.i365.tech/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 underline-offset-2 hover:text-gray-300 hover:underline"
              >
                i365.tech
              </a>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
