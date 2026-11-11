import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function TemporaryChatRoomPage() {
  return (
    <DiscoveryPageLayout
      title="临时聊天房间 — 无需注册，不保留历史 | Free4Chat"
      description="即时开启支持语音、文字、文件和屏幕共享的临时房间。无需账号或注册；空房间会自动过期，不保留永久历史记录。"
      path="/temporary-chat-room"
      ctaId="temporary-chat-room"
      h1="支持语音、文字和屏幕共享的临时房间"
    >
      <p>
        Free4Chat 房间用于一次性交流，交流结束后便会消失。无需创建账号或安装软件；
        开启房间、分享链接，即可开始交流。
      </p>

      <h2>房间功能</h2>
      <ul>
        <li>直接在浏览器中进行语音聊天。</li>
        <li>支持表情回应的文字聊天。</li>
        <li>传输文件和图片，并支持直接预览。</li>
        <li>屏幕共享（桌面浏览器）。</li>
        <li>只需复制房间链接并发送，即可邀请他人。</li>
      </ul>

      <h2>为什么是临时房间</h2>
      <ul>
        <li>无需注册、账号或管理用户身份。</li>
        <li>
          服务器不保留永久房间历史记录；空房间会自动过期。
        </li>
        <li>
          房间没有固定倒计时：有人在房间时它会保持开放，空置一段时间后才会过期。
        </li>
      </ul>

      <h2>请注意</h2>
      <p>
        Free4Chat 并非端到端加密的通讯工具：媒体会经过中继，以便参与者彼此收听和观看；你的房间名称和昵称
        会保存在浏览器的 <code>localStorage</code> 中，直到你清除相关数据。详情请查看
        <Link href="/privacy">隐私说明</Link>。
      </p>

      <h2>深入了解</h2>
      <ul>
        <li>
          <Link href="/docs/getting-started/browser-room">
            浏览器房间快速入门
          </Link>{" "}
          — 逐步了解如何创建并分享房间。
        </li>
        <li>
          <Link href="/docs/concepts/room">房间与数据归属</Link> — 了解房间管理哪些内容，以及参与者如何保留隐私。
        </li>
        <li>
          想邀请 Agent 加入房间？请查看
          <Link href="/ai-agent-room">AI Agent 房间</Link>。
        </li>
      </ul>
    </DiscoveryPageLayout>
  )
}
