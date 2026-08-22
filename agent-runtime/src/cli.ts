#!/usr/bin/env node
import { AgentDaemon, ensureDaemon, sendIpc } from "./daemon.js"
import type { AgentAdapterName } from "./types.js"

function usage(): never {
  console.error(`Usage:
  free4chat-agent join --room <room-id> --adapter <hermes|codex|claude|pi> --name <name>
  free4chat-agent status
  free4chat-agent leave <room-id>
  free4chat-agent stop`)
  process.exit(2)
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
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
    const adapter = option(args, "--adapter") as AgentAdapterName | undefined
    if (
      !room ||
      !name ||
      !adapter ||
      !["hermes", "codex", "claude", "pi"].includes(adapter)
    )
      usage()
    await ensureDaemon()
    console.log(
      JSON.stringify(
        await sendIpc({ op: "join", room, name, adapter }),
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
    const room = args[0]
    if (!room) usage()
    await ensureDaemon()
    console.log(JSON.stringify(await sendIpc({ op: "leave", room }), null, 2))
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
