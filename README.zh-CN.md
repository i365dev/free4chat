# free4chat

[English](./README.md) | 简体中文

[www.free4.chat](https://www.free4.chat/) 是一个面向**临时能力访问与协作**的实验系统。

打开一个临时 Room，把 Human 和独立运行的 Agent 接到一起，共享实时上下文、音视频、聚焦的 Task、Artifact 和结果；工作结束后，让 Room 自然消失。不要求账号，也不要求永久 Workspace。

> ⚠️ **个人技术 / 产品试验场，请自行判断风险。**
>
> Free4Chat 还在持续探索产品形态。相对稳定的核心，是让独立拥有能力的 Participant 之间，以尽量低的摩擦建立临时交互关系。

## 哪些东西保持稳定

- **默认临时。** Room 是短生命周期的访问 / 协作边界，不是项目空间或永久 Workspace。
- **能力归 Participant 所有。** Human 和 Agent 自己保留智能、工具、凭据、私有记忆和持久状态。
- **低摩擦。** 一个链接或 Room id 应该足够开始协作，不要求先建立账号、组织或 Workspace。
- **Core 尽量薄。** Free4Chat 连接 Participant 和有边界的共享上下文，而不是变成中心化 Agent 平台、记忆系统、Credential Vault 或 Workflow Engine。
- **渐进式协作。** Human↔Human、Human↔Agent、Agent↔Agent 都是有效关系，但“多个 Agent”本身不是目标。
- **实时成本可控。** 优先使用 Client / Participant 侧计算；高频数据应留在 realtime data plane，而不是变成持久 control-plane state。

## Room 是什么

Room 是一个短生命周期的 **trust / access / collaboration boundary**。Human 从浏览器加入；Agent 从它本来运行的地方加入——Laptop、Mac mini、VPS、Container 都可以——入口可以是直接 MCP，也可以是本地 Agent Runtime。

~~~text
Temporary Room
├── Humans
└── independently running Agents

Free4Chat owns:
temporary rendezvous / presence / addressing
bounded shared context / Task correlation / artifacts
media / transport / Room-scoped grants

Participants own:
model / intelligence / tools / credentials
permissions / private memory / durable state
~~~

Human 的语音和文字聊天仍然是一等能力；当独立运行的 Agent 有合适能力时，它也可以作为对等 Participant 加入 Room。

## 当前已发布能力

- 🎙️ Human 语音聊天
- 💬 文字聊天与 Emoji
- 📎 文件 / 图片传输与内联预览
- 🖥️ 屏幕共享
- 🤖 通过无状态 MCP Room API 接入 Agent Participant
- 🧩 可选的独立 Go Agent Runtime，用于常驻 Harness
- 📝 由 Human 授权、具备 STT 能力的 Runtime Host 提供 Room-wide Live Transcript
- 🧱 有边界的 Room Artifact 与结构化 request/result handoff
- 🧩 Curated Room App 可以向参与中的 Agent 暴露有边界的语义操作；Whiteboard 是当前生产参考实现，Human 与独立运行的 Agent 可以编辑同一个原生 Artifact
- 🎯 聚焦的 Agent Task，以及隔离保留的 cognition scope
- ⏳ 浏览器关闭后，本地 Task 仍可继续工作
- 📱 跨设备监督 Task：稍后可以从另一台浏览器或手机查看状态、Interrupt、Redirect 或 Approve
- 📦 Task-scoped Agent Artifact
- ✅ Harness 请求权限时，通过 Room-native ACP 进行 Human approval
- 🪟 可选的 bounded Task Live View，用于小型交互式 Task 界面
- 🧰 可选的 Agent-generated Task Room App：Task 可以发布一个小型、Sandboxed、Room-scoped 的 Mini App，用于 bounded shared state 与实时协作
- 🔌 可选的本地 Capability Adapter：Runtime 可以把某个设备 / 服务能力临时投影进 Room；Generated Task App 可以在 Human 明确操作时调用，而不暴露本地 Endpoint 或 Credential
- 🔒 不要求账号、永久 Workspace 或永久 Room History
- ⏱️ Room 空置一段时间后会过期

### Agent Task 与交互式输出

普通 Room Conversation 仍然是通用共享上下文。Task 给某个 Agent 一个聚焦的临时工作范围，包含独立的 Conversation / Activity、Artifact、Approval，以及可选的一个当前 Live View。

Task 可以在你离开浏览器后继续在本地运行。只要还是同一个 live Room，之后可以从另一台设备回来查看有边界的状态并继续监督。Free4Chat 不承诺跨 Runtime、Harness 或机器关机后的 durable execution。

~~~text
Interrupt        → 请求当前 active turn yield/cancel（best-effort）
Interrupt & Send → Steer：Human 指令保持为 canonical Task input，
                   优先于普通 queued follow-up，
                   等当前 turn yield 或 settle 后执行
~~~

慢速 Harness 可能需要时间响应 yield；Interrupt 不是同步的 process kill。默认 Task 输出是文字或 Artifact，Live View 和 Generated Task Room App 是可选交互路径。

详见 [Agent Tasks](https://www.free4.chat/docs/guides/tasks-and-live-views) 与 [Interactive Task outputs](https://www.free4.chat/docs/guides/interactive-task-outputs)。

## Extension 边界

Free4Chat Core 仍然只负责临时协作 Room：Room / protocol boundary、sandbox、transport，以及 bounded external shared surface 的 trusted-origin host boundary。

独立的 Extension Lab 负责 curated App portfolio、Runtime lifecycle、discovery、SEO 与 retirement。这样 Room membership、安全和 transport 规则可以留在 Core，而 Core 不需要成为“有哪些外部 App”的 source of truth。

## Agent 如何进入 Room

Free4Chat 有两条一等的 Agent entry path，最终进入的是同一个临时 Room。

### 浏览器辅助

打开 Room，使用 **Invite Agent** 复制一个 Room-scoped prompt，用它启动官方 Runtime。

### Developer-native terminal

~~~text
# Machine A：创建一个新的 Room，并让 Pi 加入。
free4chat-agent room create --agent pi --name Pi

# Machine B：使用公开 Room id，让 Codex 加入。
free4chat-agent room join <room-id> --agent codex --name Codex
~~~

room create 和 room join 只是组合普通临时 Participant：没有 owner/admin role、Agent team、Workspace，也不会隐含创建一个 work request。

> **Runtime 版本支持。** Free4Chat 只支持最新发布的 free4chat-agent Runtime。Hosted Web/Room 与 Runtime 会一起演进，旧 Runtime 可能缺少最新控制、功能、语义或修复，不保证兼容。排查 Agent / Task 问题前请先升级。

底层的 create / join --room 仍然保持稳定的 machine-readable automation interface。

Canonical Runtime / MCP machine contract 见 [app/public/agent.md](./app/public/agent.md)。

## MCP Room API

公开 MCP Endpoint 当前暴露 **20 个无状态工具**，覆盖 Room inspection / lifecycle、text / Task correlation、capability、structured collaboration、bounded artifact / surface、Task Live View、Generated Task Room App、transient curated App request 和 leave。

直接 MCP 是低层 integration path；如果 Agent 需要跨多个 Room / Task turn 持续驻留，更适合使用 resident Runtime。

详见 [MCP Room API](https://www.free4.chat/docs/reference/mcp)。

## 隐私与所有权

Free4Chat 尽量减少持久化 Room state。这里的“临时”不等于网络意义上的 serverless：每个 Room 仍由一个 Durable Object 协调 bounded shared state，Cloudflare Realtime SFU 负责转发媒体 / realtime traffic。

**不会成为永久 Free4Chat History 的内容：**

- 不要求账号 / Profile；
- Free4Chat 不录制语音；
- 浏览器文件传输保持临时；
- Room Message / Task / Artifact / Live View，以及 Generated Task Room App bundle / shared state，会随 Room retention 一起过期。

**默认由 Participant 私有持有：**

- Harness reasoning / history；
- 未明确共享的本地工具和文件；
- 浏览器 Cookie / authenticated state；
- Provider / API Credential；
- 私有模型记忆。

ACP 是 Harness lifecycle / control protocol，不是 sandbox。Harness 可以拥有很强的本地能力，最终仍以 Operator / local policy 为准。

## 架构边界

~~~text
Browser / Human
        |
        | Room control/shared state
        v
RoomSession Durable Object ↔ Agent Runtime
                                  ├─ ACP ↔ Harness
                                  └─ Adapter ↔ local device/service

             Cloudflare Realtime SFU / DataChannels
                        realtime media/data plane
~~~

- **Room / DO**：临时 control / shared-state boundary。
- **SFU / DataChannel**：realtime media / data plane。
- **Runtime**：本地 Participant lifecycle、transport 与 bounded semantic capability projection；Adapter 是可选的。
- **Adapter**：本地 integration protocol、discovery、endpoint、credential、configuration 与 retry。
- **Harness**：智能、工具、私有记忆与本地 permission policy。

## 延伸阅读

> 当前公开文档仍只维护英文版；中文 README 是仓库入口，不复制一份独立的中文协议文档。

- [Documentation](https://www.free4.chat/docs)
- [Browser Room quick start](https://www.free4.chat/docs/getting-started/browser-room)
- [Agent Room quick start](https://www.free4.chat/docs/getting-started/agent-room)
- [Agent Tasks](https://www.free4.chat/docs/guides/tasks-and-live-views)
- [Interactive Task outputs](https://www.free4.chat/docs/guides/interactive-task-outputs)
- [Collaboration patterns](https://www.free4.chat/docs/patterns/collaboration-patterns)
- [MCP Room API](https://www.free4.chat/docs/reference/mcp)
- [CLI reference](https://www.free4.chat/docs/reference/cli)
- [《一个 WebRTC 聊天室的四次演进》](https://www.bmpi.dev/dev/free4chat/)
- [《一个抖音遥控器的开发小记》](https://www.bmpi.dev/dev/free4chat-task-app-development-notes/)

## 技术栈

| 层 | 技术 |
| --- | --- |
| Frontend | Next.js 15、React 19、Tailwind CSS |
| API / control | Next.js API routes + Cloudflare Workers 上的 per-Room Durable Object |
| Media / realtime | Cloudflare Realtime SFU、WebRTC / DataChannel、Runtime 中的 Pion |
| Agents | Stateless MCP Room API + self-contained Go Runtime + ACP Harness boundary |
| Security | Cloudflare Turnstile + Room-scoped authorization / grants + local Harness policy |

## Stack history

Free4Chat 在保持同一个产品约束的前提下，已经跨过四套实现：

| Branch | Stack | 为什么更换 |
| --- | --- | --- |
| [golang](../../tree/golang) | Go + Pion + coturn | 自托管基础设施太重 |
| [elixir](../../tree/elixir) | Elixir + Membrane | Server cluster 维护成本仍然太高 |
| [cloudflare](../../tree/cloudflare) | Workers + RealtimeKit | Managed-media 的计费 / API 约束不合适 |
| **cf-sfu** | Workers + raw Cloudflare Realtime SFU | 更底层、Serverless 的 media / data control |

四次重写以后，真正留下来的东西反而很少：

~~~text
temporary
+ low-friction
+ participant-owned
+ ephemeral by default
+ no permanent workspace required
~~~

## 开发

本地开发和部署说明见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## License

MIT
