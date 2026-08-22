import { JsonRpcProcess } from "../core/jsonRpcProcess.js"
import type {
  AgentAdapterName,
  HarnessAdapter,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../types.js"
import { renderUntrustedRoomTurn } from "./types.js"

export class CodexAdapter implements HarnessAdapter {
  readonly name: AgentAdapterName = "codex"
  private readonly rpc = new JsonRpcProcess(
    process.env.FREE4CHAT_CODEX_COMMAND ?? "codex",
    ["app-server"]
  )
  private threadId?: string

  async ensureSession(): Promise<void> {
    this.rpc.start()
    if (!this.threadId) {
      await this.rpc.request("initialize", {
        clientInfo: { name: "free4chat-agent-runtime", version: "0.1.0" },
        capabilities: {},
      })
      const result = (await this.rpc.request("thread/start", {})) as {
        thread?: { id?: string }
      }
      if (!result.thread?.id)
        throw new Error("Codex App Server did not return a thread id")
      this.threadId = result.thread.id
    }
  }

  async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
    await this.ensureSession()
    const textParts: string[] = []
    const unsubscribe = this.rpc.subscribe((notification) => {
      if (notification.method !== "item/agentMessage/delta") return
      const params = notification.params as
        { delta?: string; text?: string } | undefined
      const text = params?.delta ?? params?.text
      if (typeof text === "string") textParts.push(text)
    })
    const completion = this.rpc.waitForNotification(
      (notification) =>
        notification.method === "turn/completed" &&
        (!notification.params ||
          (notification.params as { threadId?: string }).threadId ===
            this.threadId)
    )
    const items: Array<Record<string, unknown>> = [
      { type: "text", text: renderUntrustedRoomTurn(input) },
    ]
    for (const event of input.events) {
      if (event.image)
        items.push({
          type: "image",
          url: `data:${event.image.mimeType};base64,${event.image.data}`,
        })
    }
    const result = (await this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: items,
    })) as { turn?: { id?: string } }
    const turnId = result.turn?.id
    const event = await completion
    const params = event.params as
      { turn?: { id?: string }; turnId?: string } | undefined
    unsubscribe()
    if (turnId && params && params.turn?.id && params.turn.id !== turnId)
      return { text: "" }
    return { text: textParts.join("").trim() }
  }

  async close(): Promise<void> {
    await this.rpc.close()
  }
}
