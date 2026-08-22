#!/usr/bin/env node
import { AgentDaemon, ensureDaemon, sendIpc } from "./daemon.js"

function usage(): never {
  console.error(`Usage:
  free4chat-agent join --room <room-id> --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name>
  free4chat-agent join --room <room-id> --agent-command <command> [--agent-arg <arg> ...] --name <name>
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
