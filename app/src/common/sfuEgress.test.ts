import { describe, expect, it, vi } from "vitest"

import {
  aggregateSfuEgressStats,
  createSfuEgressSampler,
  sfuEgressDelta,
  SFU_EGRESS_SAMPLE_INTERVAL_MS,
} from "./sfuEgress"

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("SFU egress stats", () => {
  it("samples at a bounded five-minute interval", () => {
    expect(SFU_EGRESS_SAMPLE_INTERVAL_MS).toBe(5 * 60 * 1000)
  })

  it("aggregates inbound audio rows and ignores outbound or unrelated rows", () => {
    expect(
      aggregateSfuEgressStats(
        new Map([
          [
            "audio-1",
            { type: "inbound-rtp", kind: "audio", bytesReceived: 120 },
          ],
          [
            "audio-2",
            { type: "inbound-rtp", mediaType: "audio", bytesReceived: 30 },
          ],
          ["outbound", { type: "outbound-rtp", kind: "audio", bytesSent: 999 }],
          ["candidate", { type: "candidate-pair", bytesReceived: 500 }],
        ])
      )
    ).toEqual({ audioBytes: 150, videoBytes: 0, dataChannelBytes: 0 })
  })

  it("aggregates inbound video and DataChannel rows when exposed", () => {
    expect(
      aggregateSfuEgressStats([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 80 },
        { type: "inbound-rtp", kind: "video", bytesReceived: 1_000 },
        { type: "inbound-rtp", mediaType: "video", bytesReceived: 250 },
        { type: "data-channel", bytesReceived: 70 },
        { type: "data-channel", bytesReceived: 30 },
      ])
    ).toEqual({ audioBytes: 80, videoBytes: 1_250, dataChannelBytes: 100 })
  })

  it("gracefully handles unavailable or malformed browser stats", () => {
    expect(
      aggregateSfuEgressStats({
        type: "inbound-rtp",
        kind: "audio",
        bytesReceived: 12,
      })
    ).toEqual({ audioBytes: 12, videoBytes: 0, dataChannelBytes: 0 })
    expect(aggregateSfuEgressStats(undefined)).toEqual({
      audioBytes: 0,
      videoBytes: 0,
      dataChannelBytes: 0,
    })
    expect(
      aggregateSfuEgressStats({
        audio: { type: "inbound-rtp", kind: "audio", bytesReceived: -1 },
        video: { type: "inbound-rtp", kind: "video", bytesReceived: NaN },
        data: { type: "data-channel" },
      })
    ).toEqual({ audioBytes: 0, videoBytes: 0, dataChannelBytes: 0 })
  })

  it("returns null for a baseline or a counter reset and never returns negative bytes", () => {
    const current = { audioBytes: 40, videoBytes: 25, dataChannelBytes: 10 }
    expect(sfuEgressDelta(null, current)).toBeNull()
    expect(
      sfuEgressDelta(
        { audioBytes: 50, videoBytes: 25, dataChannelBytes: 10 },
        current
      )
    ).toBeNull()
    expect(
      sfuEgressDelta(
        { audioBytes: 20, videoBytes: 5, dataChannelBytes: 4 },
        current
      )
    ).toEqual({ audioBytes: 20, videoBytes: 20, dataChannelBytes: 6 })
  })

  it("emits only new non-zero deltas and re-baselines a new PeerConnection", async () => {
    let now = 1_000
    const emit = vi.fn()
    const sampler = createSfuEgressSampler(emit, () => now)
    const firstPeerConnection = {}
    const firstStats = vi
      .fn()
      .mockResolvedValueOnce([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 100 },
      ])
      .mockResolvedValueOnce([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 100 },
      ])
      .mockResolvedValueOnce([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 175 },
      ])

    sampler.sample(firstPeerConnection, firstStats, "interval")
    await settle()
    now += 300_000
    sampler.sample(firstPeerConnection, firstStats, "interval")
    await settle()
    expect(emit).not.toHaveBeenCalled()

    now += 300_000
    sampler.sample(firstPeerConnection, firstStats, "interval")
    await settle()
    expect(emit).toHaveBeenCalledWith(
      {
        audioBytes: 75,
        videoBytes: 0,
        dataChannelBytes: 0,
        totalBytes: 75,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      firstPeerConnection
    )

    const secondPeerConnection = {}
    const secondStats = vi
      .fn()
      .mockResolvedValueOnce([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 12 },
      ])
    now += 300_000
    sampler.sample(secondPeerConnection, secondStats, "disconnect")
    await settle()
    expect(emit).toHaveBeenCalledTimes(1)

    now += 60_000
    secondStats.mockResolvedValueOnce([
      { type: "inbound-rtp", kind: "audio", bytesReceived: 12 },
      { type: "data-channel", bytesReceived: 20 },
      { type: "inbound-rtp", kind: "video", bytesReceived: 8 },
    ])
    sampler.sample(secondPeerConnection, secondStats, "leave")
    await settle()
    expect(emit).toHaveBeenLastCalledWith(
      {
        audioBytes: 0,
        videoBytes: 8,
        dataChannelBytes: 20,
        totalBytes: 28,
        intervalMs: 60_000,
        sampleReason: "leave",
      },
      secondPeerConnection
    )
  })

  it("swallows getStats and analytics failures", async () => {
    const emit = vi.fn(() => {
      throw new Error("analytics unavailable")
    })
    const sampler = createSfuEgressSampler(emit)
    const peerConnection = {}
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("stats unavailable"))
      .mockResolvedValueOnce([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 10 },
      ])
      .mockResolvedValueOnce([
        { type: "inbound-rtp", kind: "audio", bytesReceived: 20 },
      ])

    expect(() =>
      sampler.sample(peerConnection, getStats, "pagehide")
    ).not.toThrow()
    await settle()
    expect(() =>
      sampler.sample(peerConnection, getStats, "pagehide")
    ).not.toThrow()
    await settle()
    expect(() =>
      sampler.sample(peerConnection, getStats, "pagehide")
    ).not.toThrow()
    await settle()
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
