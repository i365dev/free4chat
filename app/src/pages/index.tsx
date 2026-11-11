import { useState, useEffect } from "react"

import Link from "next/link"
import { useRouter } from "next/router"

import {
  generateParticipantName,
  generateRoomName,
} from "../common/cosmicNames"
import {
  saveRoomToLocalStorage,
  umamiEvent,
  trackAnalyticsEvent,
  hashRoom,
} from "../common/utils"
import DiscoveryFooter from "../components/DiscoveryFooter"
import Header from "../components/Header"
import SignalCollapseText from "../components/SignalCollapseText"

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
    <div className="overflow-x-clip">
      <Header></Header>
      <main className="flex min-h-screen flex-col">
        <div className="mx-auto flex w-full max-w-screen-xl flex-1 flex-col px-4 py-12">
          <div className="slogan home-cosmic-hero mx-auto my-auto w-full max-w-5xl text-center">
            <p className="font-mono text-xs tracking-widest text-emerald-500">
              FREE4CHAT://中继 — 链路就绪
              <span className="cursor-blink" />
            </p>
            <h1
              aria-label="开启临时房间，让人与 Agent 在此相聚。"
              className="mt-5 text-3xl font-extrabold uppercase tracking-tight sm:text-4xl"
            >
              <SignalCollapseText
                text={"开启一个房间。\n让人与 Agent 在此相聚。"}
                className="psy-headline"
              />
            </h1>

            <p className="mx-auto mt-5 font-mono text-sm text-emerald-300/70 sm:leading-relaxed">
              为人与独立运行的 Agent 提供临时协作空间。一起交流、发起专注的
              Agent
              任务，也可以离开后从其他设备回来继续跟进。无需注册，也没有永久工作区。
            </p>
            <p className="mx-auto mt-1 font-mono text-xs text-emerald-600 sm:leading-relaxed">
              房间不保留永久历史记录；空房间会自动过期。
            </p>

            <div className="mx-auto mt-8 w-full max-w-xl lg:max-w-5xl">
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="relative min-w-0 flex-1 sm:flex-[1.35]">
                  <label htmlFor="room" className="sr-only">
                    房间名称
                  </label>

                  <input
                    type="text"
                    id="room"
                    placeholder="输入房间名称"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    className={inputClasses}
                  />

                  <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                    <button
                      onClick={() => setRoomName(generateRoomName())}
                      type="button"
                      className={diceClasses}
                      title="随机生成房间名称"
                      aria-label="随机生成房间名称"
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

                <div className="relative min-w-0 flex-1">
                  <label htmlFor="nickname" className="sr-only">
                    昵称
                  </label>

                  <input
                    type="text"
                    id="nickname"
                    value={nickName}
                    placeholder="输入你的昵称"
                    onChange={(e) => setNickName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") go()
                    }}
                    className={inputClasses}
                  />

                  <span className="absolute inset-y-0 right-0 grid w-10 place-content-center">
                    <button
                      onClick={() => setNickName(generateParticipantName())}
                      type="button"
                      className={diceClasses}
                      title="随机生成昵称"
                      aria-label="随机生成昵称"
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
                  aria-label="进入房间"
                  className="home-join-cta group flex w-full items-center justify-center rounded-none border border-emerald-300/60 bg-emerald-500 px-5 py-3 font-mono text-sm font-bold uppercase tracking-widest text-black transition hover:bg-emerald-400 focus:outline-none focus:ring focus:ring-emerald-300 sm:w-auto"
                >
                  <span className="relative z-10">
                    进入房间{" "}
                    <span className="home-join-cta__arrow" aria-hidden="true">
                      →
                    </span>
                  </span>
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
                  [+] 更多选项
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
                      启用屏幕共享
                      {!isDesktop && (
                        <span className="text-emerald-900">
                          （仅限桌面设备）
                        </span>
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
                    {copied ? "已复制！" : "复制房间链接"}
                  </button>
                </div>
              )}

              <div className="mt-8 w-full border border-emerald-900/60 bg-black/40 p-4 text-left">
                <p className="font-mono text-xs font-bold uppercase tracking-widest text-amber-400">
                  {"## 开发者与 Agent"}
                </p>
                <code className="mt-2 block break-all font-mono text-xs text-emerald-400">
                  $ free4chat-agent room create --agent pi --name Pi
                </code>
                <Link
                  href="/docs/getting-started/agent-room"
                  className="mt-3 inline-flex font-mono text-xs text-emerald-500 underline-offset-4 transition hover:text-emerald-300 hover:underline focus:outline-none focus:ring focus:ring-emerald-500/40"
                >
                  通过终端创建并加入房间 →
                </Link>
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-emerald-600">
                  Agent Runtime 支持 macOS 和
                  Linux。人类可通过受支持的浏览器监督， 包括 Windows
                  和移动设备。
                </p>
              </div>
            </div>

            <section
              aria-labelledby="room-surfaces-heading"
              className="mt-20 w-full border-t border-emerald-900/60 py-16 text-left"
            >
              <p className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// 房间内的协作"}
              </p>
              <h2
                id="room-surfaces-heading"
                className="mt-3 text-center font-mono text-xl font-bold uppercase tracking-wide text-emerald-200 sm:text-2xl"
              >
                一个临时房间，三种协作方式
              </h2>
              <div className="mt-8 grid gap-4 md:grid-cols-[1fr_1.25fr_1fr]">
                <article className="border border-emerald-900/70 bg-black/30 p-5">
                  <h3 className="font-mono text-sm font-bold uppercase tracking-wide text-emerald-300">
                    房间交流
                  </h3>
                  <p className="mt-3 font-mono text-xs leading-relaxed text-emerald-600">
                    与人和 Agent 通过语音、文字、文件和屏幕共享进行交流。
                  </p>
                </article>
                <article className="border border-emerald-400/60 bg-emerald-950/30 p-5 shadow-[0_0_28px_rgba(16,185,129,0.08)]">
                  <h3 className="font-mono text-sm font-bold uppercase tracking-wide text-emerald-200">
                    Agent 任务
                  </h3>
                  <p className="mt-3 font-mono text-xs leading-relaxed text-emerald-400/80">
                    为 Agent
                    分配专注任务。你可以先离开，稍后回来查看进度、继续跟进、
                    审批、打断或调整方向。
                  </p>
                  <Link
                    href="/agent-tasks"
                    className="mt-4 inline-block font-mono text-xs text-emerald-300 underline-offset-4 hover:underline"
                  >
                    了解 Agent 任务 →
                  </Link>
                </article>
                <article className="border border-emerald-900/70 bg-black/30 p-5">
                  <h3 className="font-mono text-sm font-bold uppercase tracking-wide text-emerald-300">
                    房间应用
                  </h3>
                  <p className="mt-3 font-mono text-xs leading-relaxed text-emerald-600">
                    打开临时共享工具或活动，不会把房间变成永久工作区。
                  </p>
                  <Link
                    href="/apps"
                    className="mt-4 inline-block font-mono text-xs text-emerald-500 underline-offset-4 hover:underline"
                  >
                    浏览房间应用 →
                  </Link>
                </article>
              </div>
            </section>

            <section
              aria-labelledby="task-supervision-heading"
              className="w-full border-t border-emerald-900/60 py-16 text-left"
            >
              <p className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// 工作仍在继续"}
              </p>
              <h2
                id="task-supervision-heading"
                className="mt-3 text-center font-mono text-xl font-bold uppercase tracking-wide text-emerald-200 sm:text-2xl"
              >
                浏览器负责监督工作，而不是拥有工作。
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-center font-mono text-xs leading-relaxed text-emerald-600">
                在房间中发起专注任务，之后可用当前浏览器或其他设备回到同一房间查看进展。
              </p>
              <ol className="mx-auto mt-8 grid max-w-4xl gap-3 font-mono text-xs sm:grid-cols-3">
                {[
                  ["01 / 开始", "在房间中为 Agent 发起专注任务。"],
                  ["02 / 离开", "关闭浏览器本身不会停止本地执行。"],
                  [
                    "03 / 返回",
                    "查看运行中、排队中或已完成的任务；继续跟进、审批、打断或调整方向。",
                  ],
                ].map(([label, body]) => (
                  <li
                    key={label}
                    className="border border-emerald-900/70 bg-black/30 p-4"
                  >
                    <strong className="text-emerald-300">{label}</strong>
                    <p className="mt-2 leading-relaxed text-emerald-600">
                      {body}
                    </p>
                  </li>
                ))}
              </ol>
              <p className="mx-auto mt-4 max-w-3xl text-center font-mono text-[11px] leading-relaxed text-emerald-800">
                任务由 Agent 的 Runtime、Harness 和所在设备执行。如果它们停止，
                执行不会继续保证；房间状态仍是临时的。
              </p>
              <p className="mt-5 text-center">
                <Link
                  href="/agent-tasks"
                  className="font-mono text-xs text-emerald-400 underline-offset-4 hover:underline"
                >
                  了解任务监督方式 →
                </Link>
              </p>
            </section>

            <section
              aria-labelledby="task-output-heading"
              className="w-full border-t border-emerald-900/60 py-16 text-left"
            >
              <p className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// 任务产出"}
              </p>
              <h2
                id="task-output-heading"
                className="mt-3 text-center font-mono text-xl font-bold uppercase tracking-wide text-emerald-200 sm:text-2xl"
              >
                Agent 可以交付不止文字。
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-center font-mono text-xs text-emerald-600">
                优先选择满足需求的最简单产出；交互界面是可选项。
              </p>
              <ol className="mx-auto mt-8 max-w-3xl space-y-2 font-mono text-xs">
                {[
                  [
                    "文字 / 文件",
                    "回答、报告、补丁或受限大小的文件——默认形式。",
                  ],
                  ["实时视图", "简洁的状态信息、表单或一组控件。"],
                  [
                    "生成式任务房间应用",
                    "受限沙箱中的小型应用，可共享房间状态，并在明确授权后使用发起任务的 Runtime 本地能力。",
                  ],
                  [
                    "外部应用",
                    "需要真实后端、任意网络访问、规模化运行或持久部署时使用。",
                  ],
                ].map(([label, body], index) => (
                  <li
                    key={label}
                    className="flex flex-col gap-2 border border-emerald-900/60 bg-black/25 p-4 sm:flex-row sm:items-center"
                  >
                    <span className="w-52 flex-none font-bold text-emerald-300">
                      {index + 1}. {label}
                    </span>
                    <span className="leading-relaxed text-emerald-600">
                      {body}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-5 text-center">
                <Link
                  href="/docs/guides/interactive-task-outputs"
                  className="font-mono text-xs text-emerald-400 underline-offset-4 hover:underline"
                >
                  选择交互式任务产出 →
                </Link>
              </p>
            </section>

            <section
              aria-labelledby="local-capabilities-heading"
              className="w-full border-t border-emerald-900/60 py-10 text-left"
            >
              <p className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// 本地能力"}
              </p>
              <h2
                id="local-capabilities-heading"
                className="mt-3 text-center font-mono text-lg font-bold uppercase tracking-wide text-emerald-200 sm:text-xl"
              >
                将本地能力带入房间，无需迁移到云端。
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-center font-mono text-xs leading-relaxed text-emerald-600">
                Runtime 可通过外部 Adapter
                提供受限的语义能力。生成式任务应用只能在用户明确操作后使用，
                本地端点和凭据始终留在本机。
              </p>
              <p className="mt-4 text-center">
                <Link
                  href="/docs/guides/interactive-task-outputs"
                  className="font-mono text-xs text-emerald-400 underline-offset-4 hover:underline"
                >
                  了解交互式任务产出 →
                </Link>
              </p>
            </section>

            <section
              aria-labelledby="multi-agent-heading"
              className="w-full border-t border-emerald-900/60 py-12 text-center"
            >
              <p className="font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// 需要更多 Agent 时"}
              </p>
              <h2
                id="multi-agent-heading"
                className="mt-3 font-mono text-lg font-bold uppercase tracking-wide text-emerald-200"
              >
                邀请另一个独立运行的 Agent 加入房间。
              </h2>
              <p className="mx-auto mt-3 max-w-2xl font-mono text-xs leading-relaxed text-emerald-600">
                每个 Agent
                都保有自己的工具、凭据和私有记忆。这里没有中央调度器， 其他
                Agent 也不会自动接管任务。
              </p>
              <Link
                href="/multi-agent-collaboration"
                className="mt-4 inline-block font-mono text-xs text-emerald-400 underline-offset-4 hover:underline"
              >
                了解多 Agent 协作 →
              </Link>
            </section>

            <nav
              aria-label="探索 Free4Chat"
              className="w-full border-t border-emerald-900/60 py-10 text-left"
            >
              <p className="text-center font-mono text-xs font-bold uppercase tracking-widest text-emerald-600">
                {"// 探索 Free4Chat"}
              </p>
              <p className="mx-auto mt-3 max-w-3xl text-center font-mono text-xs leading-relaxed text-emerald-600">
                在其他设备运行任务、连接不同
                Agent、共享产出，或发布临时任务应用。{" "}
                <Link
                  href="/use-cases"
                  className="text-emerald-400 underline-offset-4 hover:underline"
                >
                  浏览使用场景 →
                </Link>
              </p>
              <div className="mt-5 grid gap-3 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["临时房间", "/temporary-chat-room"],
                  ["Agent 任务", "/agent-tasks"],
                  ["AI Agent 房间", "/ai-agent-room"],
                  ["房间应用", "/apps"],
                  ["多 Agent 协作", "/multi-agent-collaboration"],
                  ["文档", "/docs"],
                ].map(([label, href]) => (
                  <Link
                    key={href}
                    href={href}
                    className="border border-emerald-900/60 bg-black/20 p-4 text-emerald-400 hover:border-emerald-700 hover:text-emerald-200"
                  >
                    {label} →
                  </Link>
                ))}
              </div>
            </nav>

            <p className="mt-6 text-center font-mono text-xs text-emerald-600">
              本网站可能会收集部分运行时技术数据用于调试，请自行评估使用风险。
            </p>
          </div>
        </div>
        <DiscoveryFooter />
      </main>
    </div>
  )
}
