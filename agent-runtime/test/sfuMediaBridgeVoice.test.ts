import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { SfuMediaBridge } from "../src/media/sfuMediaBridge.js"
import type { DecodedParticipantHandle } from "../src/media/participantHandle.js"
import type {
  PeerConnectionLike,
  MediaTrackLike,
  RtpPacketLike,
} from "../src/media/peerConnectionLike.js"
import type { SessionDescriptionLike } from "../src/media/sfuRestClient.js"

const handle: DecodedParticipantHandle = {
  roomId: "room-1",
  participantId: "agent-1",
  participantToken: "tok",
  sessionId: "sess-agent",
  apiToken: "api",
} as never

type Op = string

function scriptedPc(ops: Op[]) {
  const pc = {
    createOffer: async () => {
      ops.push("offer")
      return {
        type: "offer",
        sdp: "offer-sdp",
      } satisfies SessionDescriptionLike
    },
    setRemoteDescription: async (description: SessionDescriptionLike) => {
      ops.push(`apply:${description.type}`)
    },
    createAnswer: async () => {
      ops.push("answer")
      return {
        type: "answer",
        sdp: "answer-sdp",
      } satisfies SessionDescriptionLike
    },
    setLocalDescription: async () => {
      ops.push("setLocal")
    },
    onTrack: {
      subscribe: (cb: (track: MediaTrackLike) => void) => {
        void cb
      },
    },
    close: () => undefined,
    armPublishAudio: async () => {
      ops.push("arm")
    },
    activatePublish: async () => {
      ops.push("activate")
    },
    deactivatePublish: async () => {
      ops.push("deactivate")
    },
    cancelTurnAudio: async () => {
      ops.push("cancelTurn")
    },
    flushAudio: async () => {
      ops.push("flush")
    },
    localPublishMid: async () => {
      ops.push("local-mid")
      return "pub-mid-9"
    },
    writePcmChunk: async (chunk: Uint8Array) => {
      ops.push(chunk.length === 960 ? "silence" : "write")
    },
    publishStats: async () => ({
      pcm_write_calls: 2,
      pcm_input_bytes: 4,
      opus_frames_written: 2,
      outbound_rtp_packets: 2,
      outbound_rtp_bytes: 200,
    }),
  }
  return pc as unknown as PeerConnectionLike & {
    armPublishAudio: () => Promise<void>
    activatePublish: () => Promise<void>
    localPublishMid: () => Promise<string | undefined>
    writePcmChunk: (chunk: Uint8Array) => Promise<void>
  }
}

const bootstrapRest = {
  createAgentSessionWithOffer: async () => ({
    sessionId: "sess-agent",
    sessionDescription: { type: "answer", sdp: "boot-answer" },
  }),
  establishDataChannelTransport: async () => ({
    dataChannels: [{ id: 1, location: "local" }],
  }),
  roomMedia: async () => [],
  subscribeTrack: async () =>
    ({
      type: "answer",
      sdp: "x",
    }) satisfies SessionDescriptionLike,
  renegotiate: async () => undefined,
}

describe("SfuMediaBridge voiceReply publication (#83 live-silence fix)", () => {
  it("arms the Pion outbound track BEFORE the publication offer and completes the full signaling sequence", async () => {
    const ops: Op[] = []
    const publishCalls: Array<{
      sessionId: string
      args: { trackName: string; mid: string; offer: SessionDescriptionLike }
    }> = []
    const confirmCalls: Array<{ sessionId: string; trackName: string }> = []

    const bridge = new SfuMediaBridge({
      mcpUrl: "https://www.free4.chat/mcp",
      handle,
      onEvent: () => undefined,
      createPeerConnection: () =>
        scriptedPc(ops) as unknown as PeerConnectionLike,
      pollIntervalMs: 1_000_000,
      publish: { trackName: "agent-voice" },
      restClient: {
        ...bootstrapRest,
        // #83: the publication call under test.
        publishAudioTrack: async (sessionId, args) => {
          ops.push("publish")
          publishCalls.push({ sessionId, args })
          return {
            sessionDescription: { type: "answer", sdp: "pub-answer" },
          } satisfies SessionDescriptionLike
        },
        confirmPublishedAudioTrackActive: async (sessionId, trackName) => {
          ops.push("confirm")
          confirmCalls.push({ sessionId, trackName })
          return true
        },
      },
    })

    await bridge.start()
    assert.equal(bridge.voicePublishCapable, true)
    await bridge.activateVoicePublish()
    assert.deepEqual(confirmCalls, [])

    // Bootstrap receive-only offer first; publication arms BEFORE its own
    // offer so the send m-line actually exists.
    assert.deepEqual(ops, [
      "offer",
      "setLocal",
      "apply:answer",
      "arm",
      "offer",
      "setLocal",
      "local-mid",
      "publish",
      "apply:answer",
      "activate",
    ])
    assert.equal(publishCalls.length, 1)
    assert.equal(publishCalls[0]!.sessionId, "sess-agent")
    assert.equal(publishCalls[0]!.args.trackName, "agent-voice")
    assert.equal(publishCalls[0]!.args.mid, "pub-mid-9")
    assert.equal(publishCalls[0]!.args.offer.sdp, "offer-sdp")

    await bridge.writeVoicePcm(new Uint8Array([1, 2]))
    await bridge.writeVoicePcm(new Uint8Array([3, 4]))
    assert.deepEqual(confirmCalls, [
      { sessionId: "sess-agent", trackName: "agent-voice" },
    ])
    assert.deepEqual(ops.slice(-4), ["silence", "confirm", "write", "write"])
    assert.deepEqual(await bridge.voicePublishStats(), {
      pcm_write_calls: 2,
      pcm_input_bytes: 4,
      opus_frames_written: 2,
      outbound_rtp_packets: 2,
      outbound_rtp_bytes: 200,
    })

    await bridge.stop()
  })

  it("retries inactive or failed readiness checks on later writes and final flush without failing audio", async () => {
    const ops: Op[] = []
    let confirmations = 0
    const bridge = new SfuMediaBridge({
      mcpUrl: "https://www.free4.chat/mcp",
      handle,
      onEvent: () => undefined,
      createPeerConnection: () =>
        scriptedPc(ops) as unknown as PeerConnectionLike,
      pollIntervalMs: 1_000_000,
      publish: { trackName: "agent-voice" },
      restClient: {
        ...bootstrapRest,
        publishAudioTrack: async () => ({}),
        confirmPublishedAudioTrackActive: async () => {
          ops.push("confirm")
          confirmations += 1
          if (confirmations === 1) return false
          if (confirmations === 2) throw new Error("temporary_lookup_failure")
          return true
        },
      },
    })

    await bridge.start()
    await bridge.activateVoicePublish()
    await assert.doesNotReject(() => bridge.writeVoicePcm(new Uint8Array([1])))
    await assert.doesNotReject(() => bridge.writeVoicePcm(new Uint8Array([2])))
    await bridge.flushVoice()
    await bridge.writeVoicePcm(new Uint8Array([3]))
    assert.equal(confirmations, 3)
    assert.deepEqual(ops.slice(-8), [
      "silence",
      "confirm",
      "confirm",
      "confirm",
      "write",
      "write",
      "flush",
      "write",
    ])
    await bridge.stop()
  })

  it("flushes again when its final readiness check activates and drains pending audio", async () => {
    const ops: Op[] = []
    let confirmations = 0
    const bridge = new SfuMediaBridge({
      mcpUrl: "https://www.free4.chat/mcp",
      handle,
      onEvent: () => undefined,
      createPeerConnection: () =>
        scriptedPc(ops) as unknown as PeerConnectionLike,
      pollIntervalMs: 1_000_000,
      publish: { trackName: "agent-voice" },
      restClient: {
        ...bootstrapRest,
        publishAudioTrack: async () => ({}),
        confirmPublishedAudioTrackActive: async () => {
          ops.push("confirm")
          confirmations += 1
          return confirmations > 2
        },
      },
    })

    await bridge.start()
    await bridge.activateVoicePublish()
    await bridge.writeVoicePcm(new Uint8Array([7]))
    await bridge.flushVoice()
    assert.deepEqual(ops.slice(-7), [
      "silence",
      "confirm",
      "confirm",
      "flush",
      "confirm",
      "write",
      "flush",
    ])
    await bridge.stop()
  })

  it("throws media_engine_publish_unsupported when the engine cannot arm/write (werift fallback boundary)", async () => {
    const ops: Op[] = []
    const barePc = {
      createOffer: async () => {
        ops.push("offer")
        return { type: "offer", sdp: "sdp" } satisfies SessionDescriptionLike
      },
      setRemoteDescription: async () => {
        ops.push("apply")
      },
      createAnswer: async () => ({ type: "answer", sdp: "sdp" }),
      setLocalDescription: async () => {},
      onTrack: { subscribe: () => undefined },
      close: () => undefined,
    }
    const bridge = new SfuMediaBridge({
      mcpUrl: "https://www.free4.chat/mcp",
      handle,
      onEvent: () => undefined,
      createPeerConnection: () => barePc as unknown as PeerConnectionLike,
      pollIntervalMs: 1_000_000,
      publish: { trackName: "agent-voice" },
      restClient: bootstrapRest,
    })

    await bridge.start()
    assert.equal(bridge.voicePublishCapable, false)
    await assert.rejects(
      bridge.activateVoicePublish(),
      /media_engine_publish_unsupported/
    )
    await bridge.stop()
  })
})

// Keep RtpPacketLike/MediaTrackLike imports referenced for strict configs.
export type { MediaTrackLike, RtpPacketLike }
