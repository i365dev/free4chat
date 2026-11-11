import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function RemoteAgentPage() {
  return (
    <DiscoveryPageLayout
      title="跨设备远程监督 Agent | Free4Chat"
      description="在 macOS 或 Linux 上运行 Agent，并通过其他浏览器或设备监督专注任务。Agent 始终运行在自己的 Runtime 和设备上。"
      path="/remote-agent"
      ctaId="remote-agent"
      h1="Agent 在那里运行，你在这里监督。"
      secondaryCta={{
        href: "/docs/getting-started/agent-room",
        label: "阅读 Agent 房间快速入门",
        analyticsTarget: "docs",
      }}
    >
      <p>
        在已有代码仓库、工具和 Harness 的设备上启动 Agent。通过临时 Free4Chat 房间，
        用其他浏览器或设备查看专注任务，同时让任务继续在原设备上执行。
      </p>

      <p>
        <strong>
          Agent Runtime 支持 macOS 和 Linux。人类可通过受支持的现代浏览器监督，
          包括 Windows 和移动设备。
        </strong>{" "}
        目前 Windows 不能作为 Agent Runtime 的运行主机。
      </p>

      <pre>
        <code>{`Mac / Linux machine
    ↓
Agent Runtime + Harness
    ↓
temporary Free4Chat Room
    ↓
Human browser
Windows / macOS / Linux / mobile`}</code>
      </pre>

      <h2>开始任务、离开，之后再回来</h2>
      <ol>
        <li>
          在 Agent 自己的 macOS 或 Linux 设备上启动它或加入房间。任务由本地 Runtime 和 Harness 执行。
        </li>
        <li>在临时房间中与 Agent 一起启动专注任务。</li>
        <li>
          需要时可离开或关闭浏览器；关闭浏览器本身不会停止本地执行。
        </li>
        <li>
          之后可通过其他受支持的浏览器或设备（包括 Windows 或手机）回到同一个仍在运行的房间。
        </li>
        <li>查看任务处于运行中、排队中还是已完成。</li>
        <li>
          继续跟进、处理审批请求、使用“打断”请求当前轮次让出执行，或通过“打断并发送”调整方向。
        </li>
      </ol>

      <h2>任务仍由原设备负责执行</h2>
      <p>
        关闭浏览器不会停止本地执行，但 Agent Runtime、Harness 和所在设备必须持续运行，
        任务才能继续。如果设备或 Runtime 停止，我们无法保证任务会持续执行。Free4Chat
        提供用于监督的临时房间，而不是云端任务运行器；房间本身也不是永久的。
      </p>

      <h2>了解更多</h2>
      <ul>
        <li>
          <Link href="/agent-tasks">Agent 任务</Link> — 继续跟进、审批、打断或调整方向。
        </li>
        <li>
          <Link href="/docs/getting-started/agent-room">
            Agent 房间快速入门
          </Link>{" "}
          — 安装受支持的 Runtime 并加入房间。
        </li>
        <li>
          <Link href="/docs/concepts/runtime-harness">Runtime 与 Harness</Link>{" "}
          — 了解本地执行由谁负责。
        </li>
      </ul>
    </DiscoveryPageLayout>
  )
}
