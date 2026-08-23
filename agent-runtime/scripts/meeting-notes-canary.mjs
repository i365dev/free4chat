import { appendFileSync } from "node:fs"
import { resolve } from "node:path"

import { McpFree4ChatClient, ResidentRoomRuntime } from "../dist/index.js"

const room = process.argv[2]
const name = process.argv[3] ?? "Doubao Canary"
const outputPath = resolve(
  process.argv[4] ?? `/tmp/free4chat-meeting-notes-${Date.now()}.jsonl`
)

if (!room) {
  console.error(
    "usage: node agent-runtime/scripts/meeting-notes-canary.mjs <room-id> [agent-name] [output.jsonl]"
  )
  process.exit(2)
}

const mcpUrl = process.env.FREE4CHAT_MCP_URL ?? "https://www.free4.chat/mcp"
const client = new McpFree4ChatClient(mcpUrl)

// This is intentionally a media/STT observer. It does not answer @mentions.
const adapter = {
  name: "meeting-notes-canary-observer",
  capabilities: { text: true, images: false, resume: false },
  async ensureSession() {},
  async runTurn() {
    return {}
  },
  async close() {},
}

function write(record) {
  const line = JSON.stringify(record)
  appendFileSync(outputPath, `${line}\n`, "utf8")
  console.log(line)
}

const runtime = new ResidentRoomRuntime({
  instanceId: `meeting-notes-canary-${Date.now()}`,
  roomId: room,
  name,
  client,
  adapter,
  mcpUrl,
  log(event, details) {
    if (
      event === "meeting_notes_media_started" ||
      event === "meeting_notes_media_stopped" ||
      event === "meeting_notes_media_start_failed"
    )
      write({ scope: "media", event, details })
  },
  onMediaEvent(event) {
    if (
      event.type === "audioTrackStarted" ||
      event.type === "audioTrackEnded" ||
      event.type === "audioFrameStats"
    )
      write({ scope: "media", ...event })
  },
  speech: {
    environment: process.env,
    onEvent({ source, event }) {
      const record = {
        scope: "stt",
        at: new Date().toISOString(),
        participantId: source.participantId,
        participantName: source.participantName,
        trackName: source.trackName,
        type: event.type,
      }
      if (event.type === "partial" || event.type === "committed")
        record.text = event.text
      if (event.type === "error") record.error = event.error
      write(record)
    },
  },
})

async function stop() {
  await runtime.stop()
  write({ scope: "process", event: "stopped" })
  process.exit(0)
}

process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())

await runtime.start()
write({
  scope: "process",
  event: "ready",
  room,
  name,
  outputPath,
  status: runtime.getStatus(),
})

await new Promise(() => {})
