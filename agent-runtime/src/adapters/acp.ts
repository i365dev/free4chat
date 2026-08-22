import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  CLIENT_METHODS,
  client,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
} from "@agentclientprotocol/sdk"

import type {
  AgentLauncher,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../types.js"
import { renderUntrustedRoomTurn } from "./types.js"

const SHUTDOWN_TIMEOUT_MS = 2_000

const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "NO_COLOR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
  "GLM_API_KEY",
  "NOUS_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "COHERE_API_KEY",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
])

export function buildHarnessEnvironment(
  launcher: AgentLauncher,
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = baseEnvironment[key]
    if (value !== undefined) environment[key] = value
  }
  // Never inherit ambient Codex privilege/configuration policy. A built-in
  // launcher may opt into an explicit safe value below.
  delete environment.CODEX_CONFIG
  delete environment.INITIAL_AGENT_MODE
  for (const [key, value] of Object.entries(launcher.environment ?? {}))
    environment[key] = value
  return environment
}

function asWebReadable(
  stream: NodeJS.ReadableStream
): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>
}

function asWebWritable(
  stream: NodeJS.WritableStream
): WritableStream<Uint8Array> {
  return Writable.toWeb(stream as Writable) as WritableStream<Uint8Array>
}

function promptBlocks(
  input: HarnessTurnInput,
  supportsImages: boolean
): ContentBlock[] {
  const blocks: ContentBlock[] = [
    { type: "text", text: renderUntrustedRoomTurn(input) },
  ]
  if (!supportsImages) return blocks
  for (const event of input.events) {
    if (!event.image) continue
    blocks.push({
      type: "image",
      data: event.image.data,
      mimeType: event.image.mimeType,
    })
  }
  return blocks
}

export class AcpHarnessAdapter implements HarnessAdapter {
  readonly name: string
  private child?: ChildProcess
  private connection?: ClientConnection
  private session?: ActiveSession
  private initializeResponse?: InitializeResponse
  private promptInFlight = false
  private closing = false
  private failureHandler?: (error: Error) => void

  constructor(
    readonly launcher: AgentLauncher,
    private readonly workingDirectory: string
  ) {
    this.name = launcher.id
  }

  get capabilities(): HarnessCapabilities | undefined {
    const agentCapabilities = this.initializeResponse?.agentCapabilities
    if (!agentCapabilities) return undefined
    return {
      text: true,
      images: agentCapabilities.promptCapabilities?.image === true,
      resume: agentCapabilities.sessionCapabilities?.resume != null,
    }
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler
  }

  private markProcessDead(child: ChildProcess, error: Error): void {
    if (this.child !== child || this.closing) return
    const connection = this.connection
    const session = this.session
    this.child = undefined
    this.connection = undefined
    this.session = undefined
    this.initializeResponse = undefined
    session?.dispose()
    connection?.close(error)
    this.failureHandler?.(error)
  }

  async ensureSession(): Promise<void> {
    if (this.session) return
    if (this.child || this.connection)
      throw new Error("ACP session is unavailable after process failure")

    const child = spawn(this.launcher.command, this.launcher.args, {
      cwd: this.workingDirectory,
      env: buildHarnessEnvironment(this.launcher),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    child.stderr?.resume()
    child.once("error", (error) => this.markProcessDead(child, error))
    child.once("exit", (code, signal) =>
      this.markProcessDead(
        child,
        new Error(`ACP process exited (${code ?? `signal:${signal}`})`)
      )
    )

    const app = client({ name: "free4chat-agent-runtime" }).onRequest(
      CLIENT_METHODS.session_request_permission,
      async () => ({ outcome: { outcome: "cancelled" } })
    )
    this.connection = app.connect(
      ndJsonStream(asWebWritable(child.stdin!), asWebReadable(child.stdout!))
    )

    try {
      this.initializeResponse = await this.connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: 1,
          clientInfo: {
            name: "free4chat-agent-runtime",
            version: "0.1.0",
          },
          // Deliberately advertise no filesystem, terminal, MCP, or other
          // host capabilities. Permission requests are cancelled as well.
          clientCapabilities: {},
        }
      )
      if (this.initializeResponse.protocolVersion !== 1)
        throw new Error(
          `Unsupported ACP protocol version: ${this.initializeResponse.protocolVersion}`
        )
      if (!this.initializeResponse.agentCapabilities)
        throw new Error("ACP agent did not advertise capabilities")
      this.session = await this.connection.agent
        .buildSession({ cwd: this.workingDirectory, mcpServers: [] })
        .start()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
    await this.ensureSession()
    if (!this.session) throw new Error("ACP session is unavailable")
    if (this.promptInFlight) throw new Error("ACP prompt is already running")
    this.promptInFlight = true
    try {
      const prompt = this.session.prompt(
        promptBlocks(input, this.capabilities?.images === true)
      )
      const [text] = await Promise.all([this.session.readText(), prompt])
      return { text: text.trim() }
    } finally {
      this.promptInFlight = false
    }
  }

  async cancelTurn(): Promise<void> {
    if (!this.session || !this.promptInFlight || !this.connection) return
    await this.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.session.sessionId,
    })
  }

  async close(): Promise<void> {
    this.closing = true
    const connection = this.connection
    const child = this.child
    const session = this.session
    this.session = undefined
    this.connection = undefined
    this.child = undefined
    if (connection && session) {
      try {
        if (
          this.initializeResponse?.agentCapabilities?.sessionCapabilities?.close
        )
          await connection.agent.request(methods.agent.session.close, {
            sessionId: session.sessionId,
          })
      } catch {
        // Process termination below is the final cleanup boundary.
      }
      session.dispose()
      connection.close()
    } else {
      connection?.close()
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, SHUTDOWN_TIMEOUT_MS)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.closing = false
  }
}
