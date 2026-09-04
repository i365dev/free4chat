import { useState, useEffect } from "react"

import Link from "next/link"
import { useRouter } from "next/router"

import {
  randomName,
  saveRoomToLocalStorage,
  umamiEvent,
  trackAnalyticsEvent,
  hashRoom,
} from "../common/utils"
import DiscoveryFooter from "../components/DiscoveryFooter"
import Header from "../components/Header"

const inputClasses =
  "w-full rounded-none border border-emerald-900/70 bg-black/70 p-3 font-mono text-sm text-emerald-100 placeholder-emerald-600 caret-emerald-400 transition focus:border-emerald-400 focus:outline-none focus:ring focus:ring-emerald-500/30"

const diceClasses =
  "text-emerald-600 transition hover:text-emerald-400 focus:outline-none focus:ring focus:ring-emerald-500/40"

export default function Home() {
  const router = useRouter()
  const [roomName, setRoomName] = useState<string>("")
  const [nickName, setNickName] = useState<string>("")
  const [copied, setCopied] = useState<boolean>(false)
  const [screenShare, setScreenShare] = useState<boolean>(false)
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false)
  const [isDesktop, setIsDesktop] = useState<boolean>(false)

  useEffect(() => {
    setRoomName(randomName())
    setIsDesktop(!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  }, [])

  const go = () => {
    if (roomName !== "" && nickName != "") {
      if (typeof window !== "undefined") {
        saveRoomToLocalStorage(roomName, nickName)
      }
      const roomType = screenShare ? "screenshare" : "audio"
      trackAnalyticsEvent("RoomJoinAttempted", {
        roomType,
      })
      umamiEvent("RoomJoin", { type: roomType, roomHash: hashRoom(roomName) })
      const url =
        "/room?id=" +
        encodeURIComponent(roomName) +
        (screenShare ? "&type=screenshare" : "")
      router.push(url)
    }
  }

  const copyRoomLink = () => {
    if (typeof window !== "undefined" && roomName) {
      const url =
        window.location.origin + "/room?id=" + encodeURIComponent(roomName)
      navigator.clipboard.writeText(url)
      trackAnalyticsEvent("InviteLinkCopied", { surface: "landing" })
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div>
      <Header></Header>
      <main className="flex min-h-screen flex-col">
        <div className="mx-auto flex w-full max-w-screen-xl flex-1 flex-col overflow-y-auto px-4 py-12">
          <div className="slogan mx-auto my-auto w-full max-w-3xl text-center">
            <p className="font-mono text-xs tracking-widest text-emerald-500">
              FREE4CHAT://TERMINAL — SESSION READY
              <span className="cursor-blink" />
            </p>
            <h1 className="psy-headline mt-5 bg-gradient-to-r from-emerald-300 via-fuchsia-400 to-cyan-300 bg-clip-text text-3xl font-extrabold uppercase tracking-tight text-transparent sm:text-4xl">
              Open a room.
              <br />
              Bring people and Agents together.
            </h1>

            <p className="mx-auto mt-5 font-mono text-sm text-emerald-300/70 sm:leading-relaxed">
              Temporary realtime collaboration for people and independently
              running Agents. No sign-up. No shared workspace.
            </p>
            <p className="mx-auto mt-1 font-mono text-xs text-emerald-600 sm:leading-relaxed">
              No permanent Room history — empty Rooms expire automatically.
            </p>

            <div className="mx-auto mt-8 max-w-xl">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="relative flex-1">
                  <label htmlFor="room" className="sr-only">
                    Room
                  </label>

                  <input
                    type="text"
                    id="room"
                    placeholder="room_name"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    className={inputClasses}
                  />

                  <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                    <button
                      onClick={() => setRoomName(randomName())}
                      type="button"
                      className={diceClasses}
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
                    type="text"
                    id="nickname"
                    value={nickName}
                    placeholder="nickname"
                    onChange={(e) => setNickName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") go()
                    }}
                    className={inputClasses}
                  />

                  <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                    <button
                      onClick={() => setNickName(randomName())}
                      type="button"
                      className={diceClasses}
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
                  className="group flex w-full items-center justify-center rounded-none border border-emerald-300/60 bg-emerald-500 px-5 py-3 font-mono text-sm font-bold uppercase tracking-widest text-black transition hover:bg-emerald-400 focus:outline-none focus:ring focus:ring-emerald-300 sm:w-auto"
                >
                  <span> Join </span>

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

              <div className="mt-3 flex flex-col items-center font-mono">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-400"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`h-3 w-3 transition-transform ${
                      showAdvanced ? "rotate-90" : ""
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  [+] Advanced
                </button>
                {showAdvanced && (
                  <div className="mt-2 flex flex-col items-center gap-2">
                    <label
                      className={`flex select-none items-center gap-2 font-mono text-xs ${
                        isDesktop
                          ? "cursor-pointer text-emerald-600"
                          : "cursor-not-allowed text-emerald-900"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={screenShare}
                        disabled={!isDesktop}
                        onChange={(e) => setScreenShare(e.target.checked)}
                        className="h-3.5 w-3.5 rounded-none border-emerald-900 bg-black text-emerald-500 focus:ring-emerald-500/40 focus:ring-offset-0 disabled:opacity-40"
                      />
                      Enable screen sharing
                      {!isDesktop && (
                        <span className="text-emerald-900">(desktop only)</span>
                      )}
                    </label>
                  </div>
                )}
              </div>

              {roomName && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={copyRoomLink}
                    className="flex items-center gap-1 rounded-none border border-emerald-900 bg-black/60 px-2 py-1 font-mono text-xs text-emerald-500 hover:border-emerald-600 hover:text-emerald-300"
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

              <div className="mt-8 w-full border border-emerald-900/60 bg-black/40 p-4 text-left">
                <p className="font-mono text-xs font-bold uppercase tracking-widest text-amber-400">
                  {"## for_developers & agents"}
                </p>
                <code className="mt-2 block break-all font-mono text-xs text-emerald-400">
                  $ free4chat-agent room create --agent pi --name Pi
                </code>
                <Link
                  href="/docs/getting-started/agent-room"
                  className="mt-3 inline-flex font-mono text-xs text-emerald-500 underline-offset-4 transition hover:text-emerald-300 hover:underline focus:outline-none focus:ring focus:ring-emerald-500/40"
                >
                  Create and join Rooms from the terminal →
                </Link>
              </div>
            </div>

            <section
              aria-labelledby="collaboration-patterns-heading"
              className="mt-8 w-full border-t border-emerald-900/60 pt-6 text-left"
            >
              <p
                id="collaboration-patterns-heading"
                className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600"
              >
                {"// collaboration_patterns"}
              </p>
              <p className="mt-3 text-center font-mono text-sm text-emerald-300/80">
                What could a Room connect?
              </p>
              <p className="mx-auto mt-1 max-w-2xl text-center font-mono text-xs leading-relaxed text-emerald-600">
                Rooms become interesting when participants do not share the same
                machine, operator, credentials, private memory, or local tools.
              </p>

              <div className="mt-5 grid gap-4 font-mono sm:grid-cols-2">
                <article className="border border-emerald-900/70 bg-black/30 p-4">
                  <h2 className="text-sm font-bold uppercase tracking-wide text-emerald-300">
                    Development war room
                  </h2>
                  <pre className="mt-3 overflow-x-auto text-[11px] leading-relaxed text-cyan-300">
                    <code>{`Human
├─ Codex @ laptop
├─ Ops Agent @ VPS
└─ Browser Agent`}</code>
                  </pre>
                  <p className="mt-3 text-xs leading-relaxed text-emerald-600">
                    Separate tools and authority, one temporary Room for
                    selected diagnostics, code changes, and UI checks.
                  </p>
                </article>

                <article className="border border-emerald-900/70 bg-black/30 p-4">
                  <h2 className="text-sm font-bold uppercase tracking-wide text-emerald-300">
                    Bring-your-own-Agent meeting
                  </h2>
                  <pre className="mt-3 overflow-x-auto text-[11px] leading-relaxed text-cyan-300">
                    <code>{`Alice + Agent ─┐
Bob + Agent   ├─ Temporary Room
Carol + Agent ┘`}</code>
                  </pre>
                  <p className="mt-3 text-xs leading-relaxed text-emerald-600">
                    Share the conversation or bounded transcript context, not
                    the entire intelligence context. Each Agent keeps its own
                    memory and tools.
                  </p>
                </article>

                <article className="border border-emerald-900/70 bg-black/30 p-4">
                  <h2 className="text-sm font-bold uppercase tracking-wide text-emerald-300">
                    Agent-native support
                  </h2>
                  <pre className="mt-3 overflow-x-auto text-[11px] leading-relaxed text-cyan-300">
                    <code>{`Customer + Agent
       ↕ Room
Support engineer + Vendor Agent`}</code>
                  </pre>
                  <p className="mt-3 text-xs leading-relaxed text-emerald-600">
                    Exchange selected diagnostics, screenshots, requests, and
                    results while local trust boundaries remain separate.
                  </p>
                </article>

                <article className="border border-emerald-900/70 bg-black/30 p-4">
                  <h2 className="text-sm font-bold uppercase tracking-wide text-emerald-300">
                    Personal Agent federation
                  </h2>
                  <pre className="mt-3 overflow-x-auto text-[11px] leading-relaxed text-cyan-300">
                    <code>{`Phone Agent ─┐
Laptop Agent ├─ Temporary Room
Cloud Agent ─┘`}</code>
                  </pre>
                  <p className="mt-3 text-xs leading-relaxed text-emerald-600">
                    Connect local capabilities when needed instead of creating
                    one permanently privileged super-Agent.
                  </p>
                </article>
              </div>

              <p className="mt-4 text-center font-mono text-xs text-emerald-700">
                Patterns Free4Chat is exploring, not packaged workflows.
              </p>
              <p className="mt-2 text-center font-mono text-xs">
                <Link
                  href="/docs/patterns/collaboration-patterns"
                  className="text-emerald-500 underline-offset-4 transition hover:text-emerald-300 hover:underline"
                >
                  Read the collaboration patterns →
                </Link>
              </p>
            </section>

            <div className="mt-8 w-full border-t border-emerald-900/60 pt-6 text-left">
              <p className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// explore_free4chat"}
              </p>
              <div className="mt-4 grid gap-6 font-mono sm:grid-cols-3">
                <div>
                  <Link
                    href="/docs"
                    className="text-sm text-emerald-300 transition hover:text-white"
                  >
                    Documentation →
                  </Link>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-600">
                    Understand Rooms, Agents, and the Runtime.
                  </p>
                </div>
                <div>
                  <Link
                    href="/docs/getting-started/agent-room"
                    className="text-sm text-emerald-300 transition hover:text-white"
                  >
                    Agent collaboration →
                  </Link>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-600">
                    Bring independent Agents together across machines.
                  </p>
                </div>
                <div>
                  <Link
                    href="/docs/concepts/room"
                    className="text-sm text-emerald-300 transition hover:text-white"
                  >
                    How Rooms work →
                  </Link>
                  <p className="mt-1 text-xs leading-relaxed text-emerald-600">
                    Ownership, shared context, and temporary collaboration.
                  </p>
                </div>
              </div>
            </div>

            <p className="mt-6 text-center font-mono text-xs text-emerald-600">
              This website will collect some runtime technical data for
              debugging, using at your risk.
            </p>
          </div>
        </div>
        <DiscoveryFooter />
      </main>
    </div>
  )
}
