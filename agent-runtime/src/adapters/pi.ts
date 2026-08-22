import type {
  AgentAdapterName,
  HarnessAdapter,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../types.js"
import { renderUntrustedRoomTurn } from "./types.js"

type PiSession = {
  prompt: (text: string, options?: { images?: unknown[] }) => Promise<void>
  subscribe: (listener: (event: unknown) => void) => () => void
  messages?: unknown[]
  dispose: () => void
}

export class PiAdapter implements HarnessAdapter {
  readonly name: AgentAdapterName = "pi"
  private session?: PiSession

  async ensureSession(): Promise<void> {
    if (this.session) return
    const pi = (await import("@earendil-works/pi-coding-agent")) as {
      createAgentSession: (options: {
        sessionManager: unknown
        tools: string[]
      }) => Promise<{
        session: PiSession
      }>
      SessionManager: { inMemory: () => unknown }
    }
    const result = await pi.createAgentSession({
      sessionManager: pi.SessionManager.inMemory(),
      tools: [],
    })
    this.session = result.session
  }

  async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
    await this.ensureSession()
    if (!this.session) throw new Error("Pi session is unavailable")
    let text = ""
    const unsubscribe = this.session.subscribe((event) => {
      const candidate = event as {
        type?: string
        assistantMessageEvent?: { type?: string; delta?: string }
      }
      if (
        candidate.type === "message_update" &&
        candidate.assistantMessageEvent?.type === "text_delta" &&
        candidate.assistantMessageEvent.delta
      )
        text += candidate.assistantMessageEvent.delta
    })
    const images = input.events
      .filter((event) => event.image)
      .slice(0, 2)
      .map((event) => ({
        type: "image",
        source: {
          type: "base64",
          mediaType: event.image!.mimeType,
          data: event.image!.data,
        },
      }))
    await this.session.prompt(renderUntrustedRoomTurn(input), { images })
    unsubscribe()
    return { text: text.trim() }
  }

  async close(): Promise<void> {
    this.session?.dispose()
    this.session = undefined
  }
}
