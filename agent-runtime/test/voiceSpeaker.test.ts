import assert from "node:assert/strict"
import { test } from "node:test"

import type {
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsAudioChunk,
} from "../src/speech/types.js"
import {
  VoiceSpeaker,
  type OutboundVoiceSink,
  type VoiceSpeakerEvent,
} from "../src/voice/speaker.js"

function chunk(tag: string): TtsAudioChunk {
  return {
    codec: "pcm_s16le",
    sampleRateHz: 24_000,
    channels: 1,
    data: new TextEncoder().encode(tag),
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

  constructor(private readonly failAfterWrite?: number) {}

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
    if (
      this.failAfterWrite !== undefined &&
      this.written.length >= this.failAfterWrite
    )
      throw new Error("track_write_failed")
    this.written.push(audio)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

interface ScriptedSynthesis {
  text: string
}

/** Provider whose sessions synthesize one tagged audio frame per requested
 * chunk, with optional per-chunk ordering delays and post-yield extras. */
class ScriptedTtsProvider implements StreamingTtsProvider {
  sessions: ScriptedSession[] = []
  createCalls = 0

  async createSession(): Promise<StreamingTtsSession> {
    this.createCalls += 1
    const session = new ScriptedSession()
    this.sessions.push(session)
    return session
  }
}

class ScriptedSession implements StreamingTtsSession {
  requests: ScriptedSynthesis[] = []
  closed = false
  /** Maps requested text to extra frames emitted after the main tag frame. */
  readonly trailingFrames = new Map<string, string[]>()
  /** Resolved to release a blocked synthesis; blocks when present. */
  private gates = new Map<string, Array<() => void>>()

  blockFor(text: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.gates.get(text) ?? []
      list.push(resolve)
      this.gates.set(text, list)
    })
  }

  async *synthesize(text: string): AsyncIterable<TtsAudioChunk> {
    this.requests.push({ text })
    const gate = this.gates.get(text)?.shift()
    if (gate) await gate
    yield chunk(`audio:${text}`)
    for (const extra of this.trailingFrames.get(text) ?? []) yield chunk(extra)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function speakerEvents(): {
  events: VoiceSpeakerEvent[]
  onEvent: (event: VoiceSpeakerEvent) => void
} {
  const events: VoiceSpeakerEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), "condition not reached")
}

test("speaker writes synthesized audio strictly in text order", async () => {
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const speaker = new VoiceSpeaker({
    provider,
    createSink: () => sink,
  })
  speaker.speak("One. Two. Three.")
  await waitFor(() => sink.written.length === 3)
  await speaker.close()
  assert.deepEqual(sink.written.map(chunkTag), [
    "audio:One.",
    "audio:Two.",
    "audio:Three.",
  ])
})

test("backpressure: no new synthesis while a sink write is pending", async () => {
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const speaker = new VoiceSpeaker({ provider, createSink: () => sink })
  sink.hold()
  speaker.speak("First. Second.")
  await waitFor(() => sink.writeCalls >= 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(provider.sessions[0]!.requests.length, 1)
  assert.equal(sink.written.length, 0)
  sink.releaseNext()
  await waitFor(() => sink.written.length >= 2)
  assert.equal(provider.sessions[0]!.requests.length, 2)
  await speaker.close()
})

test("cancel stops queued and current audio; late frames never reach the sink", async () => {
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const { events } = speakerEvents()
  const speaker = new VoiceSpeaker({
    provider,
    createSink: () => sink,
    onEvent: (event) => events.push(event),
  })
  sink.hold()
  sink.hold()
  speaker.speak("Alpha. Beta. Gamma.")
  // Let Alpha land, then pin the pipeline inside Beta's write so the rest
  // of the test observes a well-defined cancellation point.
  await waitFor(() => sink.writeCalls >= 1)
  sink.releaseNext()
  await waitFor(() => sink.writeCalls >= 2)
  provider.sessions[0]!.trailingFrames.set("Beta.", ["late-frame"])
  speaker.cancel()
  sink.releaseNext()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(sink.written.map(chunkTag), ["audio:Alpha.", "audio:Beta."])
  assert.equal(
    provider.sessions[0]!.requests.some((request) => request === "Gamma."),
    false
  )
  assert.equal(provider.sessions[0]!.closed, true)
  assert.ok(events.some((event) => event.type === "turnCancelled"))
  await speaker.close()
})

test("speak implicitly cancels the previous unfinished turn", async () => {
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const speaker = new VoiceSpeaker({ provider, createSink: () => sink })
  sink.hold()
  speaker.speak("Old answer. Still old.")
  await waitFor(() => provider.sessions.length >= 1)
  speaker.speak("New answer.")
  sink.releaseNext()
  await waitFor(() => provider.createCalls === 2)
  await waitFor(() => sink.written.map(chunkTag).includes("audio:New answer."))
  const tags = sink.written.map(chunkTag)
  assert.ok(!tags.includes("audio:Still old."))
  assert.equal(provider.sessions[0]!.closed, true)
  await speaker.close()
})

test("sink is created lazily once, reused across turns, closed by close()", async () => {
  let created = 0
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const speaker = new VoiceSpeaker({
    provider,
    createSink: () => {
      created += 1
      return sink
    },
  })
  speaker.speak("A.")
  await waitFor(() => sink.written.length === 1)
  speaker.speak("B.")
  await waitFor(() => sink.written.length === 2)
  assert.equal(created, 1)
  await speaker.close()
  assert.equal(sink.closed, true)
})

test("a broken track fails the turn, then the next turn gets a fresh sink", async () => {
  const provider = new ScriptedTtsProvider()
  const sinks = [new FakeSink(0), new FakeSink()]
  let index = 0
  const { events } = speakerEvents()
  const speaker = new VoiceSpeaker({
    provider,
    createSink: () => sinks[index++]!,
    onEvent: (event) => events.push(event),
  })
  speaker.speak("First try. Second sentence.")
  await waitFor(() => events.some((event) => event.type === "turnFailed"))
  assert.ok(
    events.some(
      (event) =>
        event.type === "turnFailed" && event.code.includes("track_write_failed")
    )
  )
  speaker.speak("Second try.")
  await waitFor(() => sinks[1]!.written.length === 1)
  assert.equal(sinks[1]!.written[0]!.data.byteLength > 0, true)
  await speaker.close()
})

test("overlong responses are truncated at maxQueuedChunks with an event", async () => {
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const { events } = speakerEvents()
  const speaker = new VoiceSpeaker({
    provider,
    createSink: () => sink,
    maxQueuedChunks: 3,
    onEvent: (event) => events.push(event),
  })
  speaker.speak("One. Two. Three. Four. Five. Six.")
  await waitFor(() => events.some((event) => event.type === "turnFinished"))
  assert.ok(sink.written.length <= 3)
  const truncated = events.find((event) => event.type === "turnTruncated")
  assert.ok(truncated && truncated.type === "turnTruncated")
  assert.equal(truncated.droppedChunks > 0, true)
  await speaker.close()
})

test("speak after close is ignored; close closes the sink exactly once", async () => {
  const provider = new ScriptedTtsProvider()
  const sink = new FakeSink()
  const speaker = new VoiceSpeaker({ provider, createSink: () => sink })
  speaker.speak("Before close.")
  await waitFor(() => sink.written.length === 1)
  await speaker.close()
  await speaker.close()
  speaker.speak("After close.")
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(provider.createCalls, 1)
  assert.equal(sink.closed, true)
  assert.equal(sink.writeCalls, 1)
})
