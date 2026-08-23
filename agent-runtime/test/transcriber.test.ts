import assert from "node:assert/strict"
import { test } from "node:test"

import type { AudioFrame, AudioSource } from "../src/media/types.js"
import { SpeechTranscriber } from "../src/speech/transcriber.js"
import type {
  SttEvent,
  StreamingSttProvider,
  StreamingSttSession,
} from "../src/speech/types.js"

function audio(value: number): AudioFrame {
  return {
    codec: "opus",
    sampleRateHz: 48_000,
    channels: 2,
    timestampMs: value,
    data: new Uint8Array([value]),
  }
}

function source(id: string, trackName = "mic"): AudioSource {
  return { participantId: id, participantName: id, trackName }
}

class ControlledSession implements StreamingSttSession {
  readonly frames: AudioFrame[] = []
  closed = false
  constructor(private readonly finalEvent?: SttEvent) {}
  private readonly output: SttEvent[] = []
  private readonly waiters: ((result: IteratorResult<SttEvent>) => void)[] = []

  async pushAudio(frame: AudioFrame): Promise<void> {
    this.frames.push(frame)
  }

  emit(event: SttEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.output.push(event)
  }

  async *events(): AsyncIterable<SttEvent> {
    while (!this.closed) {
      if (this.output.length > 0) {
        yield this.output.shift()!
        continue
      }
      const next = await new Promise<IteratorResult<SttEvent>>((resolve) =>
        this.waiters.push(resolve)
      )
      if (next.done) return
      yield next.value
    }
  }

  async close(): Promise<void> {
    if (this.finalEvent) this.emit(this.finalEvent)
    this.closed = true
    while (this.waiters.length > 0)
      this.waiters.shift()!({ value: undefined, done: true })
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("test timed out")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test("transcriber creates one attributed session per Human track", async () => {
  const sessions: ControlledSession[] = []
  const provider: StreamingSttProvider = {
    async createSession() {
      const session = new ControlledSession()
      sessions.push(session)
      return session
    },
  }
  const events: { source: AudioSource; event: SttEvent }[] = []
  const transcriber = new SpeechTranscriber({
    provider,
    onEvent: (event) => events.push(event),
  })
  transcriber.acceptAudio(source("human-a"), audio(1))
  transcriber.acceptAudio(source("human-b"), audio(2))
  await waitFor(() => sessions.length === 2)
  assert.deepEqual(
    sessions.map((session) => session.frames[0]?.data[0]),
    [1, 2]
  )

  sessions[0]!.emit({ type: "committed", text: "A" })
  await waitFor(() => events.length === 1)
  assert.equal(events[0]!.source.participantId, "human-a")
  assert.equal(events[0]!.event.type, "committed")

  transcriber.handleMediaEvent({
    type: "audioTrackEnded",
    participantId: "human-a",
    trackName: "mic",
    reason: "participant_left",
  })
  await waitFor(() => sessions[0]!.closed)
  await transcriber.close()
  assert.equal(sessions[1]!.closed, true)
})

test("transcriber fails only the overflowing track and keeps other tracks alive", async () => {
  const sessions: ControlledSession[] = []
  const provider: StreamingSttProvider = {
    async createSession() {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const session = new ControlledSession()
      sessions.push(session)
      return session
    },
  }
  const events: { source: AudioSource; event: SttEvent }[] = []
  const transcriber = new SpeechTranscriber({
    provider,
    maxFramesPerTrack: 2,
    onEvent: (event) => events.push(event),
  })
  transcriber.acceptAudio(source("overflow"), audio(1))
  transcriber.acceptAudio(source("overflow"), audio(2))
  transcriber.acceptAudio(source("overflow"), audio(3))
  transcriber.acceptAudio(source("healthy"), audio(4))
  await waitFor(() => events.some((event) => event.event.type === "error"))
  const error = events.find((event) => event.event.type === "error")!
  assert.equal(error.source.participantId, "overflow")
  await waitFor(() => sessions.length === 2)
  assert.equal(sessions[0]!.closed, true)
  assert.equal(sessions[1]!.frames[0]?.data[0], 4)
  await transcriber.close()
})

test("transcriber keeps bounded startup audio while the provider handshakes", async () => {
  const sessions: ControlledSession[] = []
  let releaseSession!: () => void
  const sessionReady = new Promise<void>((resolve) => {
    releaseSession = resolve
  })
  const events: { source: AudioSource; event: SttEvent }[] = []
  const provider: StreamingSttProvider = {
    async createSession() {
      await sessionReady
      const session = new ControlledSession()
      sessions.push(session)
      return session
    },
  }
  const transcriber = new SpeechTranscriber({
    provider,
    onEvent: (event) => events.push(event),
  })
  for (let value = 1; value <= 64; value += 1)
    transcriber.acceptAudio(source("handshake"), audio(value))

  assert.equal(
    events.some((event) => event.event.type === "error"),
    false
  )
  releaseSession()
  await waitFor(() => sessions.length === 1)
  await waitFor(() => sessions[0]!.frames.length === 64)
  assert.equal(sessions[0]!.frames[0]!.data[0], 1)
  assert.equal(sessions[0]!.frames[63]!.data[0], 64)
  await transcriber.close()
})

test("transcriber drains a provider's final event before ending a track", async () => {
  let session: ControlledSession | undefined
  const events: { source: AudioSource; event: SttEvent }[] = []
  const provider: StreamingSttProvider = {
    async createSession() {
      const created = new ControlledSession({
        type: "committed",
        text: "最后一句",
      })
      session = created
      return created
    },
  }
  const transcriber = new SpeechTranscriber({
    provider,
    onEvent: (event) => events.push(event),
  })
  transcriber.acceptAudio(source("human"), audio(1))
  await waitFor(() => Boolean(session))

  transcriber.handleMediaEvent({
    type: "audioTrackEnded",
    participantId: "human",
    trackName: "mic",
    reason: "participant_left",
  })
  await waitFor(() => Boolean(session?.closed && events.length === 1))
  assert.equal(events[0]!.event.type, "committed")
  assert.equal(
    events[0]!.event.type === "committed" ? events[0]!.event.text : undefined,
    "最后一句"
  )
  await transcriber.close()
})
