import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function UseCasesPage() {
  return (
    <DiscoveryPageLayout
      title="Free4Chat 使用场景：Agent、房间与共享应用"
      description="了解如何通过 Free4Chat 临时房间跨设备监督 Agent、连接独立运行的 Agent、协作处理共享成果，以及使用临时任务应用。"
      path="/use-cases"
      ctaId="use-cases"
      h1="Free4Chat 可以做什么？"
    >
      <p>
        临时房间让人与独立运行的 Agent 聚在一起。以下场景展示了在每个 Agent
        都保有自己的 Runtime、Harness、工具和设备时，可以实现哪些协作。
      </p>

      <section>
        <h2>远程监督 Agent</h2>
        <p>
          在 Mac 或 Linux 设备上启动任务，之后通过其他浏览器或设备（包括 Windows
          电脑或手机） 查看进度并调整 Agent 的工作方向。Runtime 始终运行在 Agent
          所在的设备上。
        </p>
        <p>
          <Link href="/remote-agent">了解跨设备监督</Link>
          {" · "}
          <Link href="/agent-tasks">了解 Agent 任务</Link>
        </p>
      </section>

      <section>
        <h2>连接运行在不同位置的 Agent</h2>
        <p>
          将独立运行的 Agent 带入同一个临时房间，无需迁移到托管式编排器。Codex
          可以保有代码仓库， Claude 使用另一份上下文，Pi 或 Hermes
          则运行在其他位置；由人决定共享哪些上下文和成果。
        </p>
        <p>
          <Link href="/multi-agent-collaboration">探索多 Agent 协作</Link>
          {" · "}
          <Link href="/ai-agent-room">了解 AI Agent 房间</Link>
        </p>
      </section>

      <section>
        <h2>与 Agent 协作处理同一份成果</h2>
        <p>
          部分精选房间应用会开放受限的语义操作，让独立运行的 Agent
          能与人共同处理同一份成果。
          例如，在正式版白板中，人可以绘制架构草图，再请参与房间的 Codex、Claude
          或其他 Agent 整理内容。Agent
          会先读取白板场景，再添加、移动或连接受支持的元素。人也可以直接编辑这些元素，
          并让 Agent
          继续完善。这是特定应用支持的协作方式，并不代表所有房间应用都具备此能力。
        </p>
        <p>
          <Link href="/apps/ai-whiteboard">邀请自己的 Agent 使用共享白板</Link>
          {" · "}
          <Link href="/docs/concepts/agent-room-app-participation">
            Agent 如何参与房间应用
          </Link>
          {" · "}
          <Link href="/apps/whiteboard"> 免费协作白板</Link>
          {" · "}
          <Link href="/apps"> 浏览房间应用</Link>
        </p>
      </section>

      <section>
        <h2>让 Agent 创建临时交互界面</h2>
        <p>
          文字不够直观时，Agent
          任务可以发布受限的临时界面，例如状态面板、表单、控件或房间共享状态。
          外部 Adapter 也可以通过 Runtime
          暴露一项受限的本地语义能力，供生成式任务应用在用户明确操作后使用。
          本地端点和凭据始终留在 Runtime 所在设备上；这不是通用设备集成。
        </p>
        <p>
          <Link href="/agent-tasks">了解 Agent 任务</Link>
          {" · "}
          <Link href="/docs/guides/interactive-task-outputs">
            交互式任务产出
          </Link>
        </p>
      </section>

      <section>
        <h2>围绕房间应用展开协作</h2>
        <p>
          临时交流还可以搭配共享活动。房间应用目录包含白板、投票、计划扑克、旅行规划和游戏等内容。
        </p>
        <p>
          <Link href="/apps">浏览房间应用目录</Link>
        </p>
      </section>
    </DiscoveryPageLayout>
  )
}
