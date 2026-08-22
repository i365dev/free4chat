import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { MessageParam } from "@anthropic-ai/sdk/resources"

import type {
  AgentAdapterName,
  HarnessAdapter,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../types.js"
import { renderUntrustedRoomTurn } from "./types.js"

export class ClaudeAdapter implements HarnessAdapter {
  readonly name: AgentAdapterName = "claude"
  private sessionId?: string

  async ensureSession(): Promise<void> {
    // Claude's supported query/resume API creates the session on the first turn.
  }

  async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
    const content: MessageParam["content"] = [
      { type: "text", text: renderUntrustedRoomTurn(input) },
    ]
    for (const event of input.events) {
      if (event.image) {
        const mimeType = [
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
        ].includes(event.image.mimeType)
          ? (event.image.mimeType as
              "image/jpeg" | "image/png" | "image/gif" | "image/webp")
          : "image/png"
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType,
            data: event.image.data,
          },
        })
      }
    }
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    }
    const options = {
      cwd: process.cwd(),
      resume: this.sessionId,
      tools: [],
      allowedTools: [],
      permissionMode: "default" as const,
      persistSession: true,
    }
    let text = ""
    for await (const result of query({
      prompt: (async function* () {
        yield message
      })(),
      options,
    })) {
      if (result.type === "system" && result.subtype === "init")
        this.sessionId = result.session_id
      if (result.type === "result" && result.subtype === "success")
        text = result.result
    }
    return { text: text.trim() }
  }

  async close(): Promise<void> {
    // query() owns and closes its subprocess after each completed turn.
  }
}
