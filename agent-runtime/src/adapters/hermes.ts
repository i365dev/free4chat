import { JsonRpcProcess } from "../core/jsonRpcProcess.js"
import type {
  AgentAdapterName,
  HarnessAdapter,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../types.js"
import { extractText, renderUntrustedRoomTurn } from "./types.js"

export class HermesAdapter implements HarnessAdapter {
  readonly name: AgentAdapterName = "hermes"
  private readonly rpc: JsonRpcProcess
  private sessionId?: string

  constructor() {
    const command = process.env.FREE4CHAT_HERMES_COMMAND ?? "hermes"
    const args = process.env.FREE4CHAT_HERMES_ARGS
      ? (JSON.parse(process.env.FREE4CHAT_HERMES_ARGS) as string[])
      : ["--tui"]
    this.rpc = new JsonRpcProcess(command, args)
  }

  async ensureSession(): Promise<void> {
    this.rpc.start()
    if (!this.sessionId) {
      const result = (await this.rpc.request("session.create", {})) as {
        session_id?: string
      }
      if (!result.session_id)
        throw new Error("Hermes did not return a session id")
      this.sessionId = result.session_id
    }
  }

  async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
    await this.ensureSession()
    const completion = this.rpc.waitForNotification(
      (notification) =>
        notification.method === "message.complete" &&
        (!notification.params ||
          (notification.params as { session_id?: string }).session_id ===
            this.sessionId)
    )
    await this.rpc.request("prompt.submit", {
      session_id: this.sessionId,
      text: renderUntrustedRoomTurn(input),
    })
    const event = await completion
    return { text: extractText(event.params) }
  }

  async close(): Promise<void> {
    await this.rpc.close()
  }
}
