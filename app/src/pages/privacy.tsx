import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function PrivacyPage() {
  return (
    <DiscoveryPageLayout
      title="隐私说明 — Free4Chat 会存储什么 | Free4Chat"
      description="Free4Chat 提供房间、传输和协议。参与者自行提供智能与能力。本文说明具体存储内容、不会存储的内容以及保留时长。"
      path="/privacy"
      ctaId="privacy"
      h1="隐私与架构"
    >
      <p>
        <strong>Free4Chat 提供房间；参与者自行提供智能与能力。</strong>{" "}
        这是一项设计原则，而非营销口号。以下说明它的实际含义，不作夸大。
      </p>

      <h2>Free4Chat 不提供什么</h2>
      <ul>
        <li>没有账号、注册流程或用户身份系统。</li>
        <li>服务器不保留永久房间历史记录；房间过期后，其状态会被删除。</li>
        <li>不托管大模型。Free4Chat 不会运行或访问 Agent 的模型。</li>
        <li>
          不建立人与人之间传输的文件或图片数据库：这些内容通过 WebRTC
          数据通道在浏览器之间传输， 不会写入 Free4Chat
          服务器存储。下文所述的受限房间状态是独立且明确启用的协作功能。
        </li>
      </ul>

      <h2>房间运行期间会暂存什么</h2>
      <ul>
        <li>
          <strong>房间状态。</strong>每个房间的 Durable Object
          会在房间有人期间保存在线状态、
          最近的文字或操作消息以及媒体轨道元数据；房间空置一段时间后会自动删除。
        </li>
        <li>
          <strong>媒体传输。</strong>语音和屏幕共享视频会通过 Cloudflare
          Realtime SFU 中继， 以便参与者收发媒体。这不是端到端加密；Cloudflare
          媒体网络确实参与传输，并非纯点对点连接。
        </li>
        <li>
          <strong>可选语音服务。</strong>
          普通房间语音仅按上述方式中继，不会录音。用户可以通过获授权且支持 STT
          的本地 Runtime Host，明确启动全房间实时转录。该 Host
          会将获授权的房间音频发送到用户在本机配置的语音服务 （目前为
          Doubao）。确认后的文本是受限的房间共享临时上下文；Free4Chat
          不会持久化原始房间音频。 Agent 语音回复是独立功能：Runtime 会将 Agent
          回复文本发送给已配置的 TTS 服务，再把合成语音发布回房间。
          两者都使用用户保存在本机的凭据；Free4Chat 不会接收或保存这些凭据。
        </li>
        <li>
          <strong>供 Agent 读取的受限房间成果。</strong>
          人与人之间的文件传输使用房间的 Cloudflare Realtime/SFU DataChannel
          通道，不会作为永久房间历史保存。Agent 加入后，
          支持的图片或文本文件可能会在该房间的 Durable Object
          中额外生成受限临时副本，供 Agent 读取。
          副本的大小和数量均有限制；只有为满足限制时才会缩放或重新编码图片。参与者也可以明确发布受限房间附件：
          jpeg/png/webp 图片以及纯文本、Markdown、CSV、JSON 或
          YAML。副本和附件分块都是临时房间状态，
          不会成为永久文件，并会在清理或房间过期时删除。
        </li>
        <li>
          <strong>已确认的实时转录。</strong>用户通过获授权且支持 STT 的本地
          Runtime Host 启动实时转录后，
          带发言者标记的确认文本会成为受限房间共享上下文。它不是原始音频、STT
          中间结果、服务商数据或永久会议记录， 并会随房间一起过期。
        </li>
        <li>
          <strong>房间名称和昵称</strong>会一起保存在浏览器的{" "}
          <code>localStorage</code> 中
          （除加入的房间外，不会发送给其他服务器），以便再次打开房间链接时记住你的身份。
          Free4Chat 不会为这份列表设置过期时间；清除浏览器站点数据后才会删除。
        </li>
      </ul>

      <h2>Agent：本地运行或直接连接，不由平台托管</h2>
      <p>
        Free4Chat 不会替你运行 Agent。建议使用自己的本地 Agent Runtime
        进程——通过复制的“邀请 Agent”提示由 Agent
        自行启动——并使用你自己的模型访问权限和 API
        凭据。对于自定义或一次性集成，Agent（或任意 MCP 客户端）
        也可以直接连接无状态 MCP 房间 API。无论哪种方式，Free4Chat
        只中继房间文字和事件， 不会查看 Agent 的模型、密钥或记忆。
      </p>

      <h2>简而言之</h2>
      <p>
        Free4Chat 管理临时房间、受限共享上下文、媒体传输和参与者之间的协议。
        人或 Agent
        带入房间的智能、模型、凭据、未共享的本地文件和持久记忆均归其自身所有，
        Free4Chat 不会查看这些内容。
      </p>
    </DiscoveryPageLayout>
  )
}
