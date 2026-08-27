import assert from "node:assert/strict"
import { test } from "node:test"

import { MeetingNotesController } from "../src/media/meetingNotesController.js"
import type {
  StreamingTtsSession,
  StreamingTtsProvider,
} from "../src/speech/types.js"
import type { DecodedParticipantHandle } from "../src/media/participantHandle.js"

function handle(): DecodedParticipantHandle {
  return { room: "room-1", participantId: "agent-1", participantToken: "t" }
}

class FakeBridge {
  started = false
  activated = false
  deactivated = 0
  stopped = false
  written: Uint8Array[] = []
  flushed = 0
  discarded = 0
  voicePublishCapable = true
  async start() {
    this.started = true
  }
  async stop() {
    this.stopped = true
  }
  async activateVoicePublish() {
    this.activated = true
  }
  async deactivateVoicePublish() {
    this.deactivated += 1
  }
  async writeVoicePcm(chunk: Uint8Array) {
    this.written.push(chunk)
  }
  async flushVoice() {
    this.flushed += 1
  }
  async cancelVoiceTurn() {
    this.discarded += 1
  }
}

function makeRoomInfo(opts: {
  mnActive: boolean
  vrActive: boolean
  vrStartedAt?: number
  vrMediaAvailable?: boolean
  vrTarget?: string
}) {
  return {
    exists: true,
    meetingNotesMediaAvailable: true,
    meetingNotes: opts.mnActive
      ? { active: true, agentParticipantId: "agent-1", startedAt: 10 }
      : { active: false },
    voiceReplyMediaAvailable: true,
    voiceReply: {
      active: opts.vrActive,
      agentParticipantId: opts.vrActive
        ? (opts.vrTarget ?? "agent-1")
        : undefined,
      startedAt: opts.vrStartedAt,
    },
    voiceReplyMediaAvailable: opts.vrMediaAvailable ?? true,
  }
}

function fakeClient(info: ReturnType<typeof makeRoomInfo>) {
  return {
    async roomInfo() {
      return info
    },
  } as never
}

function pcm(text: string) {
  return {
    codec: "pcm_s16le" as const,
    sampleRateHz: 24_000,
    channels: 1,
    data: Buffer.from(`pcm:${text}`),
  }
}

function providerFor(chunks: Array<{ text: string }>) {
  let i = 0
  return {
    async createSession() {
      const index = i++
      return {
        async *synthesize(text: string) {
          void chunks[index]
          yield pcm(`${text}#${index}`)
          void chunks
        },
        async close() {},
      } satisfies StreamingTtsSession
    },
  } satisfies StreamingTtsProvider
}

function controller(
  bridge: FakeBridge,
  tts: () => Promise<StreamingTtsProvider | null>,
  log: (message: string, data?: Record<string, string | number>) => void = () =>
    undefined
) {
  return new MeetingNotesController({
    client: fakeClient(makeRoomInfo({ mnActive: false, vrActive: false })),
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: handle(),
    onEvent: () => undefined,
    createBridge: () => bridge as never,
    createPeerConnection: (() => ({ close() {} })) as never,
    restClient: {} as never,
    log,
    voiceReply: { createTtsProvider: tts },
  })
}

test("voice diagnostics expose grant state and unresolved TTS without secrets", async () => {
  const bridge = new FakeBridge()
  const logs: Array<{
    message: string
    data?: Record<string, string | number>
  }> = []
  const c = controller(
    bridge,
    () => Promise.resolve(null),
    (message, data) => logs.push({ message, data })
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(null)
  )

  const state = logs.find((entry) => entry.message === "voice_reply_state")
  assert.deepEqual(state?.data, {
    voice_reply_media_available: 1,
    voice_reply_active: 1,
    voice_reply_targets_self: 1,
    voice_reply_grant_epoch_present: 1,
    voice_reply_grant_epoch_changed: 0,
  })
  assert.ok(
    logs.some((entry) => entry.message === "voice_reply_tts_unresolved")
  )
  assert.ok(
    logs.every((entry) => !JSON.stringify(entry).includes("agent-1")),
    "voice diagnostics must not include participant identifiers"
  )
})

test("voice diagnostics keep media availability separate from target matching", async () => {
  const bridge = new FakeBridge()
  const logs: Array<{
    message: string
    data?: Record<string, string | number>
  }> = []
  const c = controller(
    bridge,
    () => Promise.resolve(null),
    (message, data) => logs.push({ message, data })
  )

  await drive(
    c,
    makeRoomInfo({
      mnActive: false,
      vrActive: true,
      vrMediaAvailable: false,
      vrTarget: "agent-1",
      vrStartedAt: 100,
    }),
    () => Promise.resolve(null)
  )
  await drive(
    c,
    makeRoomInfo({
      mnActive: false,
      vrActive: true,
      vrMediaAvailable: true,
      vrTarget: "other-agent",
      vrStartedAt: 100,
    }),
    () => Promise.resolve(null)
  )

  const states = logs.filter((entry) => entry.message === "voice_reply_state")
  assert.deepEqual(
    states.map((entry) => entry.data),
    [
      {
        voice_reply_media_available: 0,
        voice_reply_active: 1,
        voice_reply_targets_self: 1,
        voice_reply_grant_epoch_present: 1,
        voice_reply_grant_epoch_changed: 0,
      },
      {
        voice_reply_media_available: 1,
        voice_reply_active: 1,
        voice_reply_targets_self: 0,
        voice_reply_grant_epoch_present: 1,
        voice_reply_grant_epoch_changed: 0,
      },
    ]
  )
})

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), "condition not reached")
}

// Poll helper: drive the private poll through start()/stop() lifecycle by
// calling the exported poll() directly.
async function drive(
  controller: MeetingNotesController,
  info: ReturnType<typeof makeRoomInfo>,
  tts: () => Promise<StreamingTtsProvider | null>
) {
  // poll() only acts while started; tests drive it directly.
  ;(controller as unknown as { stopped: boolean }).stopped = false
  // Replace client so each poll sees fresh state.
  ;(controller as unknown as { options: { client: unknown } }).options.client =
    fakeClient(info)
  ;(
    controller as unknown as {
      options: {
        voiceReply?: {
          createTtsProvider: () => Promise<StreamingTtsProvider | null>
        }
      }
    }
  ).options.voiceReply = { createTtsProvider: tts }
  await (controller as unknown as { poll: () => Promise<void> }).poll()
}

test("voiceReply stays inactive without a grant", async () => {
  const bridge = new FakeBridge()
  const c = controller(bridge, () =>
    Promise.reject(new Error("should not build"))
  )
  await drive(c, makeRoomInfo({ mnActive: false, vrActive: false }), () =>
    Promise.reject(new Error("x"))
  )
  await drive(c, makeRoomInfo({ mnActive: false, vrActive: false }), () =>
    Promise.reject(new Error("x"))
  )
  assert.equal(current(c), null)
})

test("grant activation builds a speaker that writes PCM through the shared bridge", async () => {
  const bridge = new FakeBridge()
  const c = controller(bridge, () =>
    Promise.resolve(providerFor([{ text: "a" }, { text: "b" }]))
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  await waitFor(() => current(c) !== null)
  current(c)!.speak("Hello.")
  await waitFor(() => bridge.written.length >= 1)
  const tags = bridge.written.map((chunk) =>
    Buffer.from(chunk).toString("utf8")
  )
  assert.deepEqual(tags, ["pcm:Hello.#0"])
})

test("epoch change tears down and rebuilds the speaker", async () => {
  const bridge = new FakeBridge()
  const c = controller(bridge, () =>
    Promise.resolve(providerFor([{ text: "a" }, { text: "b" }]))
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "first" }]))
  )
  await waitFor(() => current(c) !== null)
  const first = current(c)
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 200 }),
    () => Promise.resolve(providerFor([{ text: "second" }]))
  )
  // Strengthened regression: the old speaker must be replaced by a REAL
  // rebuilt one, not merely end up "not first" (null would also pass that).
  await waitFor(() => {
    const now = current(c)
    return now !== null && now !== first
  })
  assert.ok(bridge.deactivated >= 1)
})

test("voice-only grant (MN off, VR on) holds exactly one shared session", async () => {
  const bridge = new FakeBridge()
  let created = 0
  const c = new MeetingNotesController({
    client: fakeClient(makeRoomInfo({ mnActive: false, vrActive: false })),
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: handle(),
    onEvent: () => undefined,
    createBridge: () => {
      created += 1
      return bridge as never
    },
    createPeerConnection: (() => ({ close() {} })) as never,
    restClient: {} as never,
    log: () => undefined,
    voiceReply: {
      createTtsProvider: () => Promise.resolve(providerFor([{ text: "a" }])),
    },
  })
  await drive(
    c,
    makeRoomInfo({ mnActive: false, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  await waitFor(() => current(c) !== null)
  current(c)!.speak("Solo.")
  await waitFor(() => bridge.written.length >= 1)
  // A steady-state re-poll with unchanged grants must never rebuild.
  await drive(
    c,
    makeRoomInfo({ mnActive: false, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  assert.equal(created, 1)
  assert.equal(Buffer.from(bridge.written[0]!).toString("utf8"), "pcm:Solo.#0")
})

test("meeting-notes-only grant (MN on, VR off) runs subscribe-only without voice", async () => {
  const bridge = new FakeBridge()
  let ttsCalls = 0
  const c = new MeetingNotesController({
    client: fakeClient(makeRoomInfo({ mnActive: false, vrActive: false })),
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: handle(),
    onEvent: () => undefined,
    createBridge: () => bridge as never,
    createPeerConnection: (() => ({ close() {} })) as never,
    restClient: {} as never,
    log: () => undefined,
    voiceReply: {
      createTtsProvider: () => {
        ttsCalls += 1
        return Promise.reject(new Error("tts must not be built"))
      },
    },
  })
  await drive(c, makeRoomInfo({ mnActive: true, vrActive: false }), () =>
    Promise.reject(new Error("unreachable"))
  )
  assert.equal(bridge.started, true)
  assert.equal(current(c), null)
  assert.equal(ttsCalls, 0)
})

test("both grants active across repeated polls keep exactly ONE media session", async () => {
  const bridge = new FakeBridge()
  let created = 0
  const c = new MeetingNotesController({
    client: fakeClient(makeRoomInfo({ mnActive: false, vrActive: false })),
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: handle(),
    onEvent: () => undefined,
    createBridge: () => {
      created += 1
      return bridge as never
    },
    createPeerConnection: (() => ({ close() {} })) as never,
    restClient: {} as never,
    log: () => undefined,
    voiceReply: {
      createTtsProvider: () => Promise.resolve(providerFor([{ text: "a" }])),
    },
  })
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  await waitFor(() => current(c) !== null)
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  assert.equal(created, 1)
  assert.ok(bridge.started)
  assert.equal(bridge.stopped, false)
})

test("with both grants gone there is no bridge left running", async () => {
  const bridge = new FakeBridge()
  const c = controller(bridge, () =>
    Promise.resolve(providerFor([{ text: "a" }]))
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "x" }]))
  )
  await waitFor(() => current(c) !== null)
  await drive(c, makeRoomInfo({ mnActive: false, vrActive: false }), () =>
    Promise.reject(new Error("unreachable"))
  )
  assert.equal(bridge.stopped, true)
  assert.equal(current(c), null)
})

test("revocation stops voice output", async () => {
  const bridge = new FakeBridge()
  const c = controller(bridge, () =>
    Promise.resolve(providerFor([{ text: "a" }]))
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "x" }]))
  )
  await waitFor(() => current(c) !== null)
  await drive(c, makeRoomInfo({ mnActive: true, vrActive: false }), () =>
    Promise.reject(new Error("no tts"))
  )
  assert.equal(current(c), null)
})

test("utterance boundaries wire through the real sink path: completion flushes via flushVoice", async () => {
  const bridge = new FakeBridge()
  const c = controller(bridge, () =>
    Promise.resolve(providerFor([{ text: "a" }]))
  )
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor([{ text: "a" }]))
  )
  await waitFor(() => current(c) !== null)
  current(c)!.speak("Hello.")
  await waitFor(() => bridge.flushed >= 1)
  assert.equal(bridge.written.length >= 1, true)
  assert.equal(bridge.discarded, 0)
})

test("a cancelled utterance discards partial carry via cancelVoiceTurn instead of flushing", async () => {
  const bridge = new FakeBridge()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let sessionIndex = 0
  const gated = {
    async createSession() {
      const index = sessionIndex++
      return {
        async *synthesize(text: string) {
          // First turn emits one frame, then pins MID-utterance so real
          // partial carry exists in the outbound path when cancel hits.
          yield pcm(`${text}#${index}a`)
          if (index === 0) await gate
          yield pcm(`${text}#${index}b`)
        },
        async close() {},
      } satisfies StreamingTtsSession
    },
  } satisfies StreamingTtsProvider
  const c = controller(bridge, () => Promise.resolve(gated))
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(gated)
  )
  await waitFor(() => current(c) !== null)
  current(c)!.speak("Held.")
  await waitFor(() => bridge.written.length >= 1)
  current(c)!.cancel()
  // The discard routes through the shared bridge, not a flush.
  await waitFor(() => bridge.discarded >= 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The cancelled tail never reaches the sink and never flushes.
  assert.equal(bridge.written.length, 1)
  assert.equal(bridge.flushed, 0)
  // A later turn still works end-to-end and flushes normally.
  current(c)!.speak("After.")
  await waitFor(() => bridge.flushed >= 1)
  assert.ok(
    bridge.written.some((chunk) =>
      Buffer.from(chunk).toString("utf8").startsWith("pcm:After.")
    )
  )
})

function current(c: MeetingNotesController) {
  return (
    c as unknown as { currentVoiceOutput(): unknown }
  ).currentVoiceOutput()
}

test("voice speaker lifecycle surfaces through the runtime log for live triage", async () => {
  const bridge = new FakeBridge()
  const logs: Array<Record<string, unknown>> = []
  const c = new MeetingNotesController({
    client: fakeClient(makeRoomInfo({ mnActive: false, vrActive: false })),
    roomId: "room-1",
    participantId: "agent-1",
    mcpUrl: "https://www.free4.chat/mcp",
    handle: handle(),
    onEvent: () => undefined,
    createBridge: () => bridge as never,
    createPeerConnection: (() => ({ close() {} })) as never,
    restClient: {} as never,
    log: (message, data) =>
      logs.push({ message, ...(data as Record<string, unknown>) }),
    voiceReply: {
      createTtsProvider: () => Promise.resolve(providerFor(["Hello world."])),
    },
  })
  await drive(
    c,
    makeRoomInfo({ mnActive: true, vrActive: true, vrStartedAt: 100 }),
    () => Promise.resolve(providerFor(["Hello world."]))
  )
  await waitFor(() => current(c) !== null)
  current(c)!.speak("Hello world.")
  await waitFor(() =>
    logs.some(
      (entry) =>
        entry.message === "voice_turn_finished" &&
        typeof entry.frames === "number" &&
        entry.frames > 0
    )
  )
  const messages = logs.map((entry) => entry.message)
  assert.ok(messages.includes("voice_reply_started"))
  assert.ok(messages.includes("voice_turn_started"))
})
