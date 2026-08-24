#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises"
import { AgentDaemon, ensureDaemon, sendIpc } from "./daemon.js"
import { collectDoctorReport, formatDoctorReport } from "./doctor.js"
import { runSpeechCommand } from "./speech/cli.js"
import { redactSecrets } from "./speech/redaction.js"

const MAX_ATTACHMENT_BYTES = 768 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
}

function usage(): never {
  console.error(`Usage:
  free4chat-agent join --room <room-id> --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name> [--capability <token>]...
  free4chat-agent join --room <room-id> --agent-command <command> [--agent-arg <arg> ...] --name <name> [--capability <token>]...
  free4chat-agent capabilities [--instance <id>] [--set <token>,<token>,...]
  free4chat-agent peers --room <room-id>
  free4chat-agent collab request --target <participant-id> --summary <text> [--request-id <id>] [--detail key=value]... [--attach <attachment-id>]... [--instance <id>]
  free4chat-agent collab respond --request-id <id> --decision <accepted|declined> [--summary <text>] [--instance <id>]
  free4chat-agent collab result --request-id <id> --status <completed|failed> --summary <text> [--detail key=value]... [--attach <attachment-id>]... [--instance <id>]
  free4chat-agent attach --file <path> [--name <file-name>] [--instance <id>]
  free4chat-agent doctor [--json]
  free4chat-agent readiness [--room <room-id>] [--agent <harness>] [--json]
  free4chat-agent speech status [--json]
  free4chat-agent speech doctor [--json]
  free4chat-agent speech setup <provider>
  free4chat-agent status
  free4chat-agent leave <instance-id>
  free4chat-agent stop`)
  process.exit(2)
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function repeatedOption(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1]) values.push(args[index + 1])
  return values
}

function keyValueOption(args: string[], name: string): Record<string, string> {
  const details: Record<string, string> = {}
  for (const entry of repeatedOption(args, name)) {
    const separator = entry.indexOf("=")
    if (separator <= 0) usage()
    details[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return details
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === "daemon") {
    await new AgentDaemon().start()
    return
  }
  if (command === "join") {
    const room = option(args, "--room")
    const name = option(args, "--name")
    const agent = option(args, "--agent")
    const agentCommand = option(args, "--agent-command")
    if (!room || !name || (!agent && !agentCommand) || (agent && agentCommand))
      usage()
    await ensureDaemon()
    console.log(
      JSON.stringify(
        await sendIpc({
          op: "join",
          room,
          name,
          agent,
          agentCommand,
          agentArgs: repeatedOption(args, "--agent-arg"),
          capabilities: repeatedOption(args, "--capability"),
        }),
        null,
        2
      )
    )
    return
  }
  if (command === "capabilities") {
    await ensureDaemon()
    const setArgument = option(args, "--set")
    const capabilities = setArgument
      ? setArgument
          .split(",")
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
      : undefined
    console.log(
      JSON.stringify(
        await sendIpc({
          op: "update-capabilities",
          instanceId: option(args, "--instance"),
          ...(capabilities ? { capabilities } : {}),
        }),
        null,
        2
      )
    )
    return
  }
  if (command === "peers") {
    const room = option(args, "--room")
    if (!room) usage()
    const { ModernMcpFree4ChatClient } =
      await import("./free4chat/modernClient.js")
    const { McpFree4ChatClient } = await import("./free4chat/client.js")
    const mcpUrl = process.env.FREE4CHAT_MCP_URL ?? "https://www.free4.chat/mcp"
    const client =
      process.env.FREE4CHAT_MCP_LEGACY === "1"
        ? new McpFree4ChatClient(mcpUrl)
        : new ModernMcpFree4ChatClient(mcpUrl)
    try {
      // Read-only discovery surface (#106): works with or without a resident
      // instance — an Agent can find peers and their participant ids before
      // any room event gives them context.
      const info = await client.roomInfo(room)
      console.log(JSON.stringify(info, null, 2))
    } finally {
      await client.close().catch(() => undefined)
    }
    return
  }
  if (command === "collab") {
    const subcommand = args[0]
    const rest = args.slice(1)
    await ensureDaemon()
    if (subcommand === "request") {
      const target = option(rest, "--target")
      const summary = option(rest, "--summary")
      if (!target || !summary) usage()
      console.log(
        JSON.stringify(
          await sendIpc({
            op: "collab-request",
            instanceId: option(rest, "--instance"),
            targetParticipantId: target,
            summary,
            requestId: option(rest, "--request-id"),
            details: keyValueOption(rest, "--detail"),
            attachmentIds: repeatedOption(rest, "--attach"),
          }),
          null,
          2
        )
      )
      return
    }
    if (subcommand === "respond") {
      const requestId = option(rest, "--request-id")
      const decision = option(rest, "--decision")
      if (!requestId || (decision !== "accepted" && decision !== "declined"))
        usage()
      console.log(
        JSON.stringify(
          await sendIpc({
            op: "collab-response",
            instanceId: option(rest, "--instance"),
            requestId,
            decision,
            summary: option(rest, "--summary"),
          }),
          null,
          2
        )
      )
      return
    }
    if (subcommand === "result") {
      const requestId = option(rest, "--request-id")
      const status = option(rest, "--status")
      const summary = option(rest, "--summary")
      if (
        !requestId ||
        (status !== "completed" && status !== "failed") ||
        !summary
      )
        usage()
      console.log(
        JSON.stringify(
          await sendIpc({
            op: "collab-result",
            instanceId: option(rest, "--instance"),
            requestId,
            status,
            summary,
            details: keyValueOption(rest, "--detail"),
            attachmentIds: repeatedOption(rest, "--attach"),
          }),
          null,
          2
        )
      )
      return
    }
    usage()
  }
  if (command === "attach") {
    const filePath = option(args, "--file")
    if (!filePath) usage()
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0 || info.size > MAX_ATTACHMENT_BYTES)
      throw new Error(
        `Attachment must be a non-empty file up to ${MAX_ATTACHMENT_BYTES} bytes`
      )
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
    const mimeType =
      option(args, "--mime") ?? MIME_BY_EXTENSION[extension] ?? "text/plain"
    const bytes = await readFile(filePath)
    await ensureDaemon()
    console.log(
      JSON.stringify(
        await sendIpc({
          op: "attach",
          instanceId: option(args, "--instance"),
          fileName:
            option(args, "--name") ??
            filePath.slice(filePath.lastIndexOf("/") + 1),
          mimeType,
          dataBase64: bytes.toString("base64"),
        }),
        null,
        2
      )
    )
    return
  }
  if (command === "readiness") {
    const [
      { buildReadinessReport, roomReadinessFromStatus },
      { collectDoctorReport },
    ] = await Promise.all([import("./readiness.js"), import("./doctor.js")])
    const roomId = option(args, "--room")
    const agentId = option(args, "--agent")
    const report = await buildReadinessReport()

    let harness: { id: string; ready: boolean; note?: string } | undefined
    if (agentId) {
      const doctor = collectDoctorReport()
      const launcher = doctor.launchers.find((l) => l.id === agentId)
      if (launcher)
        harness = {
          id: launcher.id,
          ready: launcher.ready,
          ...(launcher.note ? { note: launcher.note } : {}),
        }
    }

    let room: ReturnType<typeof roomReadinessFromStatus>
    if (roomId) {
      let instances: Array<{
        instanceId: string
        roomId?: string
        participantId?: string
      }> | null = null
      try {
        await ensureDaemon()
        instances = (await sendIpc({ op: "status" })) as never
      } catch {
        instances = null
      }
      room = roomReadinessFromStatus(roomId, instances)
    }

    console.log(
      JSON.stringify(
        {
          ...report,
          ...(harness ? { harness } : {}),
          ...(room ? { room } : {}),
        },
        null,
        2
      )
    )
    return
  }
  if (command === "doctor") {
    const report = collectDoctorReport()
    console.log(
      args.includes("--json")
        ? JSON.stringify(report, null, 2)
        : formatDoctorReport(report)
    )
    return
  }
  if (command === "speech") {
    const subcommand = args[0]
    await runSpeechCommand(args)
    // Best-effort #105 hot reload: only a successful credential setup needs
    // to reach resident runtimes; status/doctor must stay side-effect free.
    if (subcommand === "setup") {
      try {
        await ensureDaemon()
        await sendIpc({ op: "reload-speech" })
      } catch {
        // Readiness remains the source of truth for the calling agent.
      }
    }
    return
  }
  if (command === "status") {
    await ensureDaemon()
    console.log(JSON.stringify(await sendIpc({ op: "status" }), null, 2))
    return
  }
  if (command === "leave") {
    const instanceId = args[0]
    if (!instanceId) usage()
    await ensureDaemon()
    console.log(
      JSON.stringify(await sendIpc({ op: "leave", instanceId }), null, 2)
    )
    return
  }
  if (command === "stop") {
    await ensureDaemon()
    console.log(JSON.stringify(await sendIpc({ op: "stop" }), null, 2))
    return
  }
  usage()
}

function formatCliError(error: unknown): string {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error)
  )
  if (/authentication required|not logged in/i.test(message))
    return "Harness authentication is required. Authenticate the selected Harness locally, then retry."
  if (/ENOENT|not found|spawn .* failed/i.test(message))
    return "Harness launcher is unavailable. Run `free4chat-agent doctor` and retry."
  if (/room_expired/i.test(message))
    return "The Free4Chat room has expired. Copy a new invite and retry."
  if (/ACP process exited|ACP session is unavailable/i.test(message))
    return "The Harness ACP process stopped before joining. Run `free4chat-agent doctor` and retry."
  if (/node/i.test(message) && /22|version/i.test(message))
    return "Node.js >=22 is required to run free4chat-agent."
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

void main().catch((error) => {
  if (process.env.FREE4CHAT_DEBUG === "1")
    console.error(
      "[debug]",
      error instanceof Error ? error.stack : String(error)
    )
  console.error(formatCliError(error))
  process.exitCode = 1
})
