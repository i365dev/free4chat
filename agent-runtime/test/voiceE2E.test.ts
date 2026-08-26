import assert from "node:assert/strict"
import { test } from "node:test"

import { ResidentRoomRuntime } from "../src/core/runtime.js"
import type {
  Free4ChatClient,
  HarnessAdapter,
  JoinResult,
  RoomEvent,
  WaitResult,
} from "../src/types.js"
import type {
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsAudioChunk,
} from "../src/speech/types.js"
import { VoiceSpeaker, type OutboundVoiceSink } from "../src/voice/speaker.js"

function chunk(tag: string): TtsAudioChunk {
  return {
    codec: "pcm_s16le",
    sampleRateHz: 24_000,
    channels: 1,
    data: new TextEncoder().encode(`audio:${tag}`),
  }
}

function chunkTag(audio: TtsAudioChunk): string {
  return new TextDecoder().decode(audio.data)
}

class FakeSink implements OutboundVoiceSink {
  written: TtsAudioChunk[] = []
  closed = false
  writeCalls = 0
  private readonly heldPromises: Promise<void>[] = []
  private readonly releases: Array<() => void> = []

  hold(): void {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.heldPromises.push(promise)
    this.releases.push(release)
  }

  releaseNext(): void {
    this.releases.shift()?.()
  }

  async writeAudio(audio: TtsAudioChunk): Promise<void> {
    this.writeCalls += 1
    const held = this.heldPromises.shift()
    if (held) await held
    this.written.push(audio)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class ScriptedProvider implements StreamingTtsProvider {
  sessions: ScriptedSession[] = []

  async createSession(): Promise<StreamingTtsSession> {
    const session = new ScriptedSession()
    this.sessions.push(session)
    return session
  }
}

class ScriptedSession implements StreamingTtsSession {
  requests: string[] = []
  closed = false

  async *synthesize(text: string): AsyncIterable<TtsAudioChunk> {
    this.requests.push(text)
    yield chunk(text)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function humanEvent(sequence: number, text: string): RoomEvent {
  return {
    sequence,
    type: "text",
    participant: { id: "human-1", name: "Human", kind: "human" },
    text,
    addressed: true,
    createdAt: sequence,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), "condition not reached")
}

test("resident runtime speaks harness responses through the outbound track", async () => {
  const callOrder: string[] = []
  const sentTexts: string[] = []
  let waits = 0
  let releaseSecondTurn!: () => void
  let secondTurnReleased = false
  let secondTurnDelivered = false
  const secondTurnGate = new Promise<void>((resolve) => {
    releaseSecondTurn = () => {
      secondTurnReleased = true
      resolve()
    }
  })

  const client: Free4ChatClient = {
    async connect() {},
    async listTools() {
      return []
    },
    async roomInfo() {
      return {
        exists: true,
        meetingNotesMediaAvailable: false,
        meetingNotes: { active: false },
      }
    },
    async joinRoom(): Promise<JoinResult> {
      return {
        participantId: "agent-1",
        participantHandle: "handle-1",
        cursor: 0,
        expiresAt: Date.now() + 90_000,
      }
    },
    async waitForEvents(_handle: string, cursor: number): Promise<WaitResult> {
      waits += 1
      if (waits === 1)
        return {
          events: [humanEvent(1, "Tell me something long.")],
          cursor: cursor + 1,
          expiresAt: Date.now() + 90_000,
        }
      await secondTurnGate
      if (secondTurnReleased && !secondTurnDelivered) {
        secondTurnDelivered = true
        return {
          events: [humanEvent(2, "Interrupting with a newer question.")],
          cursor: cursor + 1,
          expiresAt: Date.now() + 90_000,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { events: [], cursor, expiresAt: Date.now() + 90_000 }
    },
    async sendText(_handle, text) {
      callOrder.push("sendText")
      sentTexts.push(text)
      return { sequence: 100 }
    },
    async readAttachment() {
      throw new Error("not used")
    },
    async leaveRoom() {},
    async close() {},
  }

  const replies = ["One. Two. Three.", "Short reply."]
  const adapter: HarnessAdapter = {
    name: "fake-harness",
    async ensureSession() {},
    async runTurn(input) {
      callOrder.push(`runTurn:${input.events[0]!.text}`)
      return { text: replies.shift() ?? "" }
    },
    async close() {},
  }

  const provider = new ScriptedProvider()
  const sink = new FakeSink()
  const speaker = new VoiceSpeaker({
    provider,
    createSink: () => sink,
  })
  sink.hold()

  const runtime = new ResidentRoomRuntime({
    instanceId: "instance-voice",
    roomId: "room-voice",
    name: "Voice Agent",
    mcpUrl: "https://www.free4.chat/mcp",
    client,
    adapter,
    createVoiceOutput: () => ({
      speak: (text: string) => {
        callOrder.push(`speak:${text}`)
        speaker.speak(text)
      },
      cancel: () => {
        callOrder.push("cancel")
        speaker.cancel()
      },
      close: () => speaker.close(),
    }),
  })
  await runtime.start()

  // Turn 1 is spoken but pinned inside the first outbound write.
  await waitFor(() => sink.writeCalls >= 1)
  assert.ok(callOrder.includes("speak:One. Two. Three."))

  // A new human turn arrives while stale audio is still queued.
  releaseSecondTurn()
  await waitFor(() => callOrder.includes("speak:Short reply."))

  // Unstick the in-flight first write; the cancelled drain must unwind
  // without synthesizing anything further from turn 1, and turn 2 audio
  // must flow in its place.
  sink.releaseNext()
  await waitFor(() => sink.written.map(chunkTag).includes("audio:Short reply."))
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(sentTexts, ["One. Two. Three.", "Short reply."])
  assert.deepEqual(provider.sessions[0]!.requests, ["One."])
  const tags = sink.written.map(chunkTag)
  assert.equal(tags[0], "audio:One.")
  assert.ok(!tags.includes("audio:Two."))
  assert.ok(!tags.includes("audio:Three."))
  assert.ok(tags.includes("audio:Short reply."))
  assert.deepEqual(callOrder, [
    "cancel",
    "runTurn:Tell me something long.",
    "sendText",
    "speak:One. Two. Three.",
    "cancel",
    "runTurn:Interrupting with a newer question.",
    "sendText",
    "speak:Short reply.",
  ])

  await runtime.stop()
  assert.equal(sink.closed, true)
  for (const session of provider.sessions) assert.equal(session.closed, true)
})
