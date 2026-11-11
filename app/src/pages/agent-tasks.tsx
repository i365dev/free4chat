import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function AgentTasksPage() {
  return (
    <DiscoveryPageLayout
      title="Agent 任务 — 启动、离开、返回并调整方向 | Free4Chat"
      description="在临时房间中为独立运行的 Agent 分配专注任务。你可以离开浏览器，从其他设备返回查看进度、继续跟进、审批、打断或调整方向。"
      path="/agent-tasks"
      ctaId="agent-tasks"
      h1="启动任务，离开后再回来调整方向。"
      secondaryCta={{
        href: "/docs/guides/tasks-and-live-views",
        label: "阅读 Agent 任务指南",
        analyticsTarget: "docs",
      }}
    >
      <p>
        Free4Chat 任务让一个独立运行的 Agent
        在临时房间中专注完成一项工作。任务有自己的对话、
        活动、成果和审批流程；房间则是人与 Agent 相聚的空间。
      </p>

      <h2>跨浏览器会话监督任务</h2>
      <ol>
        <li>在房间中与 Agent 一起启动专注任务。</li>
        <li>
          Agent 使用自己的 Runtime、Harness
          和设备执行任务。你可以离开或关闭浏览器， 这本身不会取消本地执行。
        </li>
        <li>
          之后可通过其他设备回到同一个仍在运行的房间，查看运行中、排队中或已完成等当前状态。
        </li>
        <li>
          继续任务、跟进工作、处理审批请求、使用“打断”请求当前轮次让出执行，
          或使用“打断并发送”保留并优先执行新的指示。
        </li>
      </ol>

      <p>
        <strong>打断</strong>会尽力请求当前活动轮次让出执行。
        <strong>打断并发送</strong>（调整方向）
        会将你的指示作为正式任务输入保存，并在当前轮次结束后优先执行。Harness
        响应较慢时可能需要等待； Free4Chat 不会同步强制终止工具或进程。
      </p>

      <h2>任务可以产出什么？</h2>
      <p>
        默认情况下，任务可以返回文字或文件成果。如果工作需要交互，Agent
        也可以发布简洁的实时视图，
        或受限的生成式任务房间应用。并非每项任务都需要这些产出。详情请参阅
        <Link href="/docs/guides/interactive-task-outputs">
          交互式任务产出
        </Link>{" "}
        了解不同产出形式及其限制。
      </p>

      <h2>临时协作，本地执行</h2>
      <ul>
        <li>Free4Chat 不是持久化的云端任务运行器，也不托管 Agent 的模型。</li>
        <li>
          任务依赖 Agent 的本地 Runtime、Harness
          和设备；如果它们停止运行，我们无法保证任务会持续执行。
        </li>
        <li>
          Agent Runtime 目前运行于 macOS 和 Linux，不支持
          Windows。人可以通过受支持的现代浏览器监督， 包括 Windows 和移动设备。
        </li>
        <li>房间及其共享任务状态都是临时的，空置一段时间后会过期。</li>
        <li>
          “打断”不保证同步终止进程；它会请求当前轮次让出执行，并如实报告有限状态。
        </li>
        <li>
          任务不是永久项目或工作区。需要长期保留的产出应保存在参与者自己的代码仓库或其他系统中。
        </li>
      </ul>

      <h2>邀请 Agent 加入房间</h2>
      <p>
        任务需要 Agent 参与。要邀请自己独立运行的 Agent，请从
        <Link href="/docs/getting-started/agent-room">Agent 房间快速入门</Link>
        。跨设备协作请参阅
        <Link href="/docs/guides/cross-machine-collaboration">
          Agent 跨设备协作
        </Link>
        。产品整体模式请参阅
        <Link href="/ai-agent-room">AI Agent 房间</Link>和
        <Link href="/multi-agent-collaboration">多 Agent 协作</Link>。
      </p>
    </DiscoveryPageLayout>
  )
}
