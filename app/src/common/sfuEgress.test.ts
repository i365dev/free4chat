import { describe, expect, it, vi } from "vitest"

import {
  aggregateSfuEgressStats,
  createSfuEgressSampler,
  SFU_EGRESS_SAMPLE_INTERVAL_MS,
  sfuEgressDelta,
} from "./sfuEgress"

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function report(
  ...stats: Array<{
    id: string
    type: string
    kind?: string
    mediaType?: string
    bytesReceived?: number
  }>
) {
  return new Map(stats.map((stat) => [stat.id, stat]))
}

describe("SFU egress stats", () => {
  it("samples at a bounded five-minute interval", () => {
    expect(SFU_EGRESS_SAMPLE_INTERVAL_MS).toBe(5 * 60 * 1000)
  })

  it("collects inbound rows by stats.id and ignores outbound or unrelated rows", () => {
    const stats = aggregateSfuEgressStats(
      new Map([
        [
          "map-key-is-not-used",
          {
            id: "audio-1",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 120,
          },
        ],
        [
          "audio-2",
          {
            id: "audio-2",
            type: "inbound-rtp",
            mediaType: "audio",
            bytesReceived: 30,
          },
        ],
        [
          "outbound",
          {
            id: "outbound",
            type: "outbound-rtp",
            kind: "audio",
            bytesSent: 999,
          },
        ],
        [
          "candidate",
          { id: "candidate", type: "candidate-pair", bytesReceived: 500 },
        ],
        [
          "missing-id",
          { type: "inbound-rtp", kind: "audio", bytesReceived: 500 },
        ],
      ])
    )

    expect([...stats.entries()]).toEqual([
      ["audio-1", { category: "audio", bytesReceived: 120 }],
      ["audio-2", { category: "audio", bytesReceived: 30 }],
    ])
  })

  it("collects separate video and DataChannel receive counters when exposed", () => {
    expect(
      aggregateSfuEgressStats(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 80,
          },
          {
            id: "video-1",
            type: "inbound-rtp",
            kind: "video",
            bytesReceived: 1_000,
          },
          {
            id: "video-2",
            type: "inbound-rtp",
            mediaType: "video",
            bytesReceived: 250,
          },
          { id: "dc-1", type: "data-channel", bytesReceived: 70 },
          { id: "dc-2", type: "data-channel", bytesReceived: 30 }
        )
      )
    ).toEqual(
      new Map([
        ["audio", { category: "audio", bytesReceived: 80 }],
        ["video-1", { category: "video", bytesReceived: 1_000 }],
        ["video-2", { category: "video", bytesReceived: 250 }],
        ["dc-1", { category: "dataChannel", bytesReceived: 70 }],
        ["dc-2", { category: "dataChannel", bytesReceived: 30 }],
      ])
    )
  })

  it("gracefully handles unavailable or malformed browser stats", () => {
    expect(
      aggregateSfuEgressStats({
        id: "single-audio",
        type: "inbound-rtp",
        kind: "audio",
        bytesReceived: 12,
      })
    ).toEqual(
      new Map([["single-audio", { category: "audio", bytesReceived: 12 }]])
    )
    expect(aggregateSfuEgressStats(undefined)).toEqual(new Map())
    expect(
      aggregateSfuEgressStats(
        report(
          {
            id: "bad-audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: -1,
          },
          {
            id: "bad-video",
            type: "inbound-rtp",
            kind: "video",
            bytesReceived: NaN,
          },
          { id: "missing-bytes", type: "data-channel" }
        )
      )
    ).toEqual(
      new Map([
        ["bad-audio", { category: "audio", bytesReceived: 0 }],
        ["bad-video", { category: "video", bytesReceived: 0 }],
        ["missing-bytes", { category: "dataChannel", bytesReceived: 0 }],
      ])
    )
  })

  it("counts new stats ids after the initial baseline and re-baselines resets", () => {
    const previous = aggregateSfuEgressStats(
      report(
        { id: "audio", type: "inbound-rtp", kind: "audio", bytesReceived: 100 },
        {
          id: "video-old",
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 200,
        },
        { id: "dc", type: "data-channel", bytesReceived: 50 }
      )
    )
    const current = aggregateSfuEgressStats(
      report(
        { id: "audio", type: "inbound-rtp", kind: "audio", bytesReceived: 150 },
        {
          id: "video-new",
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 10,
        },
        { id: "dc", type: "data-channel", bytesReceived: 50 }
      )
    )

    expect(sfuEgressDelta(previous, current)).toEqual({
      audioBytes: 50,
      videoBytes: 10,
      dataChannelBytes: 0,
    })
    expect(sfuEgressDelta(null, current)).toBeNull()
  })

  it("re-baselines one reset stats id without suppressing unrelated deltas", () => {
    const previous = aggregateSfuEgressStats(
      report(
        { id: "audio", type: "inbound-rtp", kind: "audio", bytesReceived: 100 },
        {
          id: "video",
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 200,
        }
      )
    )
    const current = aggregateSfuEgressStats(
      report(
        { id: "audio", type: "inbound-rtp", kind: "audio", bytesReceived: 150 },
        {
          id: "video",
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 10,
        }
      )
    )

    expect(sfuEgressDelta(previous, current)).toEqual({
      audioBytes: 50,
      videoBytes: 0,
      dataChannelBytes: 0,
    })
  })

  it("emits valid audio when a video stats object disappears", async () => {
    let now = 1_000
    const emit = vi.fn()
    const sampler = createSfuEgressSampler(emit, () => now)
    const peerConnection = {}
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 100,
          },
          {
            id: "video",
            type: "inbound-rtp",
            kind: "video",
            bytesReceived: 200,
          }
        )
      )
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 160,
        })
      )

    sampler.sample(peerConnection, getStats, "interval")
    await settle()
    now += 300_000
    sampler.sample(peerConnection, getStats, "interval")
    await settle()

    expect(emit).toHaveBeenCalledWith(
      {
        audioBytes: 60,
        videoBytes: 0,
        dataChannelBytes: 0,
        totalBytes: 60,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      peerConnection
    )
  })

  it("counts an existing RTP stream and a newly appearing video stream", async () => {
    let now = 1_000
    const emit = vi.fn()
    const sampler = createSfuEgressSampler(emit, () => now)
    const peerConnection = {}
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 100,
          },
          {
            id: "video-old",
            type: "inbound-rtp",
            kind: "video",
            bytesReceived: 200,
          }
        )
      )
      .mockResolvedValueOnce(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 150,
          },
          {
            id: "video-new",
            type: "inbound-rtp",
            kind: "video",
            bytesReceived: 10,
          }
        )
      )
      .mockResolvedValueOnce(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 180,
          },
          {
            id: "video-new",
            type: "inbound-rtp",
            kind: "video",
            bytesReceived: 30,
          }
        )
      )

    sampler.sample(peerConnection, getStats, "interval")
    await settle()
    now += 300_000
    sampler.sample(peerConnection, getStats, "interval")
    await settle()
    expect(emit).toHaveBeenLastCalledWith(
      {
        audioBytes: 50,
        videoBytes: 10,
        dataChannelBytes: 0,
        totalBytes: 60,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      peerConnection
    )

    now += 300_000
    sampler.sample(peerConnection, getStats, "interval")
    await settle()
    expect(emit).toHaveBeenLastCalledWith(
      {
        audioBytes: 30,
        videoBytes: 20,
        dataChannelBytes: 0,
        totalBytes: 50,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      peerConnection
    )
  })

  it("keeps RTP deltas when a DataChannel stats object disappears", async () => {
    let now = 1_000
    const emit = vi.fn()
    const sampler = createSfuEgressSampler(emit, () => now)
    const peerConnection = {}
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 100,
          },
          { id: "dc", type: "data-channel", bytesReceived: 50 }
        )
      )
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 140,
        })
      )

    sampler.sample(peerConnection, getStats, "interval")
    await settle()
    now += 300_000
    sampler.sample(peerConnection, getStats, "interval")
    await settle()

    expect(emit).toHaveBeenCalledWith(
      {
        audioBytes: 40,
        videoBytes: 0,
        dataChannelBytes: 0,
        totalBytes: 40,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      peerConnection
    )
  })

  it("counts a newly appearing DataChannel stats object", async () => {
    let now = 1_000
    const emit = vi.fn()
    const sampler = createSfuEgressSampler(emit, () => now)
    const peerConnection = {}
    const getStats = vi
      .fn()
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 100,
        })
      )
      .mockResolvedValueOnce(
        report(
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 140,
          },
          { id: "dc", type: "data-channel", bytesReceived: 25 }
        )
      )

    sampler.sample(peerConnection, getStats, "interval")
    await settle()
    now += 300_000
    sampler.sample(peerConnection, getStats, "interval")
    await settle()

    expect(emit).toHaveBeenCalledWith(
      {
        audioBytes: 40,
        videoBytes: 0,
        dataChannelBytes: 25,
        totalBytes: 65,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      peerConnection
    )
  })

  it("establishes a completely fresh baseline after PeerConnection replacement", async () => {
    let now = 1_000
    const emit = vi.fn()
    const sampler = createSfuEgressSampler(emit, () => now)
    const firstPeerConnection = {}
    const secondPeerConnection = {}
    const firstStats = vi.fn().mockResolvedValueOnce(
      report({
        id: "audio",
        type: "inbound-rtp",
        kind: "audio",
        bytesReceived: 100,
      })
    )
    const secondStats = vi
      .fn()
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 100,
        })
      )
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 130,
        })
      )

    sampler.sample(firstPeerConnection, firstStats, "interval")
    await settle()
    now += 300_000
    sampler.sample(secondPeerConnection, secondStats, "interval")
    await settle()
    expect(emit).not.toHaveBeenCalled()

    now += 300_000
    sampler.sample(secondPeerConnection, secondStats, "interval")
    await settle()
    expect(emit).toHaveBeenCalledWith(
      {
        audioBytes: 30,
        videoBytes: 0,
        dataChannelBytes: 0,
        totalBytes: 30,
        intervalMs: 300_000,
        sampleReason: "interval",
      },
      secondPeerConnection
    )
  })

  it("emits only non-zero deltas and swallows stats or analytics failures", async () => {
    const emit = vi.fn(() => {
      throw new Error("analytics unavailable")
    })
    const sampler = createSfuEgressSampler(emit)
    const peerConnection = {}
    const getStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("stats unavailable"))
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 10,
        })
      )
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 10,
        })
      )
      .mockResolvedValueOnce(
        report({
          id: "audio",
          type: "inbound-rtp",
          kind: "audio",
          bytesReceived: 20,
        })
      )

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
    expect(() =>
      sampler.sample(peerConnection, getStats, "pagehide")
    ).not.toThrow()
    await settle()
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
