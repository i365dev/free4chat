#!/usr/bin/env node
import { AgentDaemon, ensureDaemon, sendIpc } from "./daemon.js"
import { collectDoctorReport, formatDoctorReport } from "./doctor.js"

function usage(): never {
  console.error(`Usage:
  free4chat-agent join --room <room-id> --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name>
  free4chat-agent join --room <room-id> --agent-command <command> [--agent-arg <arg> ...] --name <name>
  free4chat-agent doctor [--json]
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
  if (command === "doctor") {
    const report = collectDoctorReport()
    console.log(
      args.includes("--json")
        ? JSON.stringify(report, null, 2)
        : formatDoctorReport(report)
    )
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
  const message = error instanceof Error ? error.message : String(error)
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
  console.error(formatCliError(error))
  process.exitCode = 1
})
