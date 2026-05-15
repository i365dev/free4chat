import { useState } from "react"

import { useRouter } from "next/router"

import { randomName, saveRoomToLocalStorage } from "../common/utils"
import Header from "../components/Header"

export default function Home() {
  const router = useRouter()
  const [roomName, setRoomName] = useState<string>("")
  const [nickName, setNickName] = useState<string>("")
  const go = () => {
    if (roomName !== "" && nickName != "") {
      if (typeof window !== "undefined") {
        saveRoomToLocalStorage(roomName, nickName)
      }
      router.push("/room?id=" + roomName)
    }
  }

  return (
    <div>
      <Header></Header>
      <main className="bg-gray-900 text-white">
        <div className="mx-auto h-screen max-w-screen-xl px-4 py-32 lg:flex lg:items-center">
          <div className="slogan mx-auto max-w-3xl text-center">
            <h1 className="bg-gradient-to-r from-green-300 via-blue-500 to-purple-600 bg-clip-text text-3xl font-extrabold text-transparent sm:text-4xl">
              Real-time <br className="sm:hidden" />
              <span></span>
            </h1>

            <p className="mx-auto mt-4 text-gray-600 sm:text-sm sm:leading-relaxed">
              There is freedom of speech, but I cannot guarantee freedom after
              speech. (Idi Amin)
            </p>

            <div className="mx-auto mt-8 max-w-xl sm:flex sm:gap-4">
              <div className="relative">
                <label htmlFor="room" className="sr-only">
                  Room
                </label>

                <input
                  type="input"
                  id="room"
                  placeholder="Room Name"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full rounded-md border-gray-200 bg-white p-3 text-gray-700 shadow-sm transition focus:border-white focus:outline-none focus:ring focus:ring-yellow-400"
                />

                <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                  <button
                    onClick={() => setRoomName(randomName())}
                    type="button"
                    className="text-black hover:bg-red-400"
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

              <div className="relative mt-4 sm:mt-0">
                <label htmlFor="nickname" className="sr-only">
                  Nickname
                </label>

                <input
                  type="input"
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
                      <path d="M13 1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10zM3 0a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V3a3 3 0 0 0-3-3H3z" />{" "}
                      <path d="M5.5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm-8 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm4-4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                    </svg>
                  </button>
                </span>
              </div>

              <button
                type="button"
                onClick={go}
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
          </div>
        </div>
        <p className="m-auto text-gray-600 sm:text-sm sm:leading-relaxed">
          This website will collect some runtime techinical data for debugging,
          using at your risk.
        </p>
      </main>
    </div>
  )
}
