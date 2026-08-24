#!/usr/bin/env node
import { AgentDaemon, ensureDaemon, sendIpc } from "./daemon.js"
import { collectDoctorReport, formatDoctorReport } from "./doctor.js"
import { runSpeechCommand } from "./speech/cli.js"
import { redactSecrets } from "./speech/redaction.js"

function usage(): never {
  console.error(`Usage:
  free4chat-agent join --room <room-id> --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name>
  free4chat-agent join --room <room-id> --agent-command <command> [--agent-arg <arg> ...] --name <name>
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
    await runSpeechCommand(args)
    // Best-effort #105 hot reload: a resident runtime picks up the new
    // credential without any rejoin/restart. No-op when no daemon is up.
    try {
      await ensureDaemon()
      await sendIpc({ op: "reload-speech" })
    } catch {
      // Readiness remains the source of truth for the calling agent.
    }
    return
  }
  return
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
