import { homedir } from "node:os"
import { join } from "node:path"

/** The local Runtime root shared by the daemon and capability stores. */
export function runtimeDirectory(): string {
  return process.env.FREE4CHAT_AGENT_DIR || join(homedir(), ".free4chat-agent")
}

export function socketPath(): string {
  return join(runtimeDirectory(), "daemon.sock")
}
