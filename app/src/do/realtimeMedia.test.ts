import { afterEach, describe, expect, it, vi } from "vitest"

import {
  closeRealtimeTracks,
  isHumanAudioTrackTarget,
  pendingCleanupHasCapacity,
  queuePendingCleanup,
  removeConfirmedMids,
  stageAgentMediaRevocation,
} from "./realtimeMedia"
import type { RoomParticipant } from "../room/types"

const env = { SFU_APP_ID: "app-id", SFU_APP_SECRET: "secret" }

function agentWithMedia(media: {
  agentSubscribedMids?: string[]
  agentPublishedMid?: string
  tracks?: Array<{ trackName: string; kind: "audio" | "video" }>
}): RoomParticipant {
  return {
    id: "agent-1",
    name: "Agent",
    kind: "agent",
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: "t",
    media: {
      sessionId: "sess-agent",
      muted: true,
      fileChannelReady: false,
      tracks: media.tracks ?? [],
      ...(media.agentSubscribedMids !== undefined
        ? { agentSubscribedMids: media.agentSubscribedMids }
        : {}),
      ...(media.agentPublishedMid !== undefined
        ? { agentPublishedMid: media.agentPublishedMid }
        : {}),
    },
  }
}

function human(): RoomParticipant {
  return {
    id: "human-1",
    name: "Human",
    kind: "human",
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: "t",
    media: {
      sessionId: "sess-human",
      muted: false,
      fileChannelReady: true,
      tracks: [{ trackName: "mic", kind: "audio" }],
    },
  }
}

describe("closeRealtimeTracks — fail-closed contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("a 2xx response is confirmed success", async () => {
    let requestedUrl: string | undefined
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response("", { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(true)
    expect(requestedUrl).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app-id/sessions/sess-1/tracks/close"
    )
  })

  it("a 401 response is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("a 429 response is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("a 500 response is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 }))
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("a network failure (fetch throws) is not treated as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    await expect(closeRealtimeTracks(env, "sess-1", ["1"])).resolves.toBe(false)
  })

  it("missing SFU credentials with real mids to close is not treated as success", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(closeRealtimeTracks({}, "sess-1", ["1"])).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("an empty mids array is trivially successful (nothing to close) even without credentials", async () => {
    await expect(closeRealtimeTracks({}, "sess-1", [])).resolves.toBe(true)
  })
})

describe("queuePendingCleanup — purely additive, never evicts to stay bounded", () => {
  it("adds a new entry for a fresh sessionId", () => {
    const result = queuePendingCleanup([], "sess-1", ["1", "2"])
    expect(result).toEqual([{ sessionId: "sess-1", mids: ["1", "2"] }])
  })

  it("merges and dedupes mids for an existing sessionId instead of duplicating the entry", () => {
    const existing = [{ sessionId: "sess-1", mids: ["1"] }]
    const result = queuePendingCleanup(existing, "sess-1", ["1", "2"])
    expect(result).toEqual([{ sessionId: "sess-1", mids: ["1", "2"] }])
  })

  it("does not mutate the existing entries it did not touch", () => {
    const existing = [{ sessionId: "sess-1", mids: ["1"] }]
    const result = queuePendingCleanup(existing, "sess-2", ["9"])
    expect(result).toEqual([
      { sessionId: "sess-1", mids: ["1"] },
      { sessionId: "sess-2", mids: ["9"] },
    ])
  })

  it("a no-op call (empty mids) returns the same entries", () => {
    const existing = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(queuePendingCleanup(existing, "sess-1", [])).toEqual(existing)
  })

  it("never evicts an unresolved entry past the soft bound — growth is unbounded here by design", () => {
    // The bound is enforced by refusing *new* admission elsewhere
    // (pendingCleanupHasCapacity), never by this function silently dropping
    // already-queued, still-unresolved cleanup work.
    let entries: ReturnType<typeof queuePendingCleanup> = []
    for (let index = 0; index < 20; index += 1) {
      entries = queuePendingCleanup(entries, `sess-${index}`, [`${index}`])
    }
    expect(entries).toHaveLength(20)
    expect(entries[0].sessionId).toBe("sess-0") // the oldest entry is still present
  })

  it("never truncates the mids on a single entry past the soft per-entry bound", () => {
    let entries: ReturnType<typeof queuePendingCleanup> = []
    for (let index = 0; index < 100; index += 1) {
      entries = queuePendingCleanup(entries, "sess-1", [`mid-${index}`])
    }
    expect(entries[0].mids).toHaveLength(100)
    expect(entries[0].mids[0]).toBe("mid-0") // the oldest mid is still present
  })
})

describe("pendingCleanupHasCapacity — the actual bound-enforcement point", () => {
  it("has capacity for a brand-new sessionId under the entry cap", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(pendingCleanupHasCapacity(entries, "sess-2")).toBe(true)
  })

  it("refuses a brand-new sessionId once the entry cap is reached", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      sessionId: `sess-${index}`,
      mids: ["1"],
    }))
    expect(pendingCleanupHasCapacity(entries, "sess-new")).toBe(false)
  })

  it("an existing sessionId is unaffected by the entry cap (it isn't a new entry)", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      sessionId: `sess-${index}`,
      mids: ["1"],
    }))
    expect(pendingCleanupHasCapacity(entries, "sess-0")).toBe(true)
  })

  it("refuses more mids on an existing entry once its per-entry cap is reached", () => {
    const entries = [
      {
        sessionId: "sess-1",
        mids: Array.from({ length: 64 }, (_, i) => `${i}`),
      },
    ]
    expect(pendingCleanupHasCapacity(entries, "sess-1", 1)).toBe(false)
  })

  it("has capacity for more mids on an existing entry under its per-entry cap", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1", "2"] }]
    expect(pendingCleanupHasCapacity(entries, "sess-1", 1)).toBe(true)
  })
})

describe("removeConfirmedMids — the narrow, merge-only-the-result half of the fetch-then-reload pattern", () => {
  it("tracks/close 2xx (success) removes exactly the confirmed mids", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(
      removeConfirmedMids(entries, [{ sessionId: "sess-1", mids: ["1"] }])
    ).toEqual([])
  })

  it("an entry that was never confirmed is left untouched — mids retained", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1"] }]
    expect(removeConfirmedMids(entries, [])).toEqual(entries)
  })

  it("only removes the confirmed subset of an entry's mids, keeping the rest", () => {
    const entries = [{ sessionId: "sess-1", mids: ["1", "2", "3"] }]
    const result = removeConfirmedMids(entries, [
      { sessionId: "sess-1", mids: ["2"] },
    ])
    expect(result).toEqual([{ sessionId: "sess-1", mids: ["1", "3"] }])
  })

  it("a mixed result only drops the entries that actually got confirmed", () => {
    const entries = [
      { sessionId: "sess-1", mids: ["1"] },
      { sessionId: "sess-2", mids: ["2"] },
    ]
    const result = removeConfirmedMids(entries, [
      { sessionId: "sess-1", mids: ["1"] },
    ])
    expect(result).toEqual([{ sessionId: "sess-2", mids: ["2"] }])
  })

  it("retry-then-success eventually clears an entry that first failed", () => {
    let entries = [{ sessionId: "sess-1", mids: ["1"] }]
    entries = removeConfirmedMids(entries, []) // first attempt: nothing confirmed
    expect(entries).toHaveLength(1)
    entries = removeConfirmedMids(entries, [
      { sessionId: "sess-1", mids: ["1"] },
    ]) // retry succeeds
    expect(entries).toHaveLength(0)
  })

  // The core Durable Object interleaving fix (round 4): a close attempt is
  // always based on a *pre-fetch* snapshot of what needed closing. By the
  // time the fetch resolves, a concurrent request may have already
  // persisted *new* pending-cleanup state (e.g. a different agent's
  // revocation). The merge must only ever remove what this specific fetch
  // confirmed — never blindly overwrite with the pre-fetch snapshot, which
  // would silently drop that concurrently-written entry.
  it("interleaving safety: only removes the confirmed pre-fetch entry, preserving anything written while the fetch was in flight", () => {
    const preFetchSnapshot = [{ sessionId: "sess-1", mids: ["mid-a"] }]
    // Simulates: after the fetch for sess-1 was kicked off (based on
    // preFetchSnapshot), a *different*, concurrent request revoked a
    // second agent and persisted its own pending-cleanup entry before this
    // fetch resolved.
    const freshAfterInterleave = [
      { sessionId: "sess-1", mids: ["mid-a"] },
      { sessionId: "sess-2", mids: ["mid-b"] },
    ]
    const merged = removeConfirmedMids(freshAfterInterleave, preFetchSnapshot)
    expect(merged).toEqual([{ sessionId: "sess-2", mids: ["mid-b"] }])
  })

  it("interleaving safety: preserves mids added to the *same* sessionId while the fetch was in flight", () => {
    const preFetchSnapshot = [{ sessionId: "sess-1", mids: ["mid-a"] }]
    // A concurrent request added a second mid to the *same* session before
    // this fetch (which only ever knew about mid-a) resolved.
    const freshAfterInterleave = [
      { sessionId: "sess-1", mids: ["mid-a", "mid-b"] },
    ]
    const merged = removeConfirmedMids(freshAfterInterleave, preFetchSnapshot)
    expect(merged).toEqual([{ sessionId: "sess-1", mids: ["mid-b"] }])
  })
})

describe("stageAgentMediaRevocation — directional split (#83 review)", () => {
  it('meeting-notes-stop ("subscribed") closes only Human→Agent mids; an active voiceReply publication survives untouched', () => {
    const participant = agentWithMedia({
      agentSubscribedMids: ["sub-1", "sub-2"],
      agentPublishedMid: "pub-1",
      tracks: [{ trackName: "agent-voice", kind: "audio" }],
    })
    const pending = stageAgentMediaRevocation(participant, [], "subscribed")
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["sub-1", "sub-2"] },
    ])
    expect(participant.media?.agentSubscribedMids).toEqual([])
    // Independent voiceReply grant media must survive an MN stop exactly:
    expect(participant.media?.agentPublishedMid).toBe("pub-1")
    expect(participant.media?.tracks).toEqual([
      { trackName: "agent-voice", kind: "audio" },
    ])
  })

  it('voice-reply-stop ("published") closes only the Agent→Human mid, drops the room-visible audio track, and keeps Meeting Notes subscriptions alive', () => {
    const participant = agentWithMedia({
      agentSubscribedMids: ["sub-1"],
      agentPublishedMid: "pub-1",
      tracks: [{ trackName: "agent-voice", kind: "audio" }],
    })
    const pending = stageAgentMediaRevocation(participant, [], "published")
    expect(pending).toEqual([{ sessionId: "sess-agent", mids: ["pub-1"] }])
    expect(participant.media?.agentPublishedMid).toBeUndefined()
    expect(participant.media?.tracks).toEqual([])
    expect(participant.media?.agentSubscribedMids).toEqual(["sub-1"])
  })

  it('leave / lease expiry / session rotation ("both") tears down every direction and drops the room-visible track', () => {
    const participant = agentWithMedia({
      agentSubscribedMids: ["sub-1", "sub-2"],
      agentPublishedMid: "pub-1",
      tracks: [{ trackName: "agent-voice", kind: "audio" }],
    })
    const pending = stageAgentMediaRevocation(participant, [])
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["sub-1", "sub-2", "pub-1"] },
    ])
    expect(participant.media).toMatchObject({
      agentSubscribedMids: [],
      tracks: [],
    })
    expect(participant.media?.agentPublishedMid).toBeUndefined()
  })

  it("a published mid already tracked among subscribed mids is queued once, not duplicated", () => {
    const participant = agentWithMedia({
      agentSubscribedMids: ["shared-mid"],
      agentPublishedMid: "shared-mid",
    })
    const pending = stageAgentMediaRevocation(participant, [])
    expect(pending).toEqual([{ sessionId: "sess-agent", mids: ["shared-mid"] }])
  })

  it("merges additively into existing pending entries instead of evicting them", () => {
    const participant = agentWithMedia({
      agentSubscribedMids: ["sub-9"],
      agentPublishedMid: "pub-9",
    })
    const existing = [{ sessionId: "sess-agent", mids: ["old"] }]
    const pending = stageAgentMediaRevocation(participant, existing, "both")
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["old", "sub-9", "pub-9"] },
    ])
  })

  it("no-ops with an unchanged queue for humans, missing media, and nothing-to-revoke agents", () => {
    const existing = [{ sessionId: "sess-x", mids: ["x"] }]
    expect(stageAgentMediaRevocation(human(), existing)).toBe(existing)
    const noMedia = { ...agentWithMedia({}), media: undefined }
    expect(stageAgentMediaRevocation(noMedia, existing)).toBe(existing)
    const textOnly = agentWithMedia({})
    expect(stageAgentMediaRevocation(textOnly, existing)).toBe(existing)
    // Directional no-op too: nothing published yet for a "published" stop.
    const subscribeOnly = agentWithMedia({ agentSubscribedMids: ["s"] })
    expect(
      stageAgentMediaRevocation(subscribeOnly, existing, "published")
    ).toBe(existing)
    expect(subscribeOnly.media?.agentSubscribedMids).toEqual(["s"])
  })

  it("staging is synchronous state mutation only — no fetch, no persistence assumptions", () => {
    const participant = agentWithMedia({ agentSubscribedMids: ["s"] })
    const before = participant.media
    stageAgentMediaRevocation(participant, [], "subscribed")
    // The participant's media object is replaced in place on the SAME
    // record the caller holds — callers persist it before any Cloudflare
    // fetch per the DO interleaving rules.
    expect(participant.media).not.toBe(before)
    expect(before.agentSubscribedMids).toEqual(["s"]) // old snapshot intact
  })
})

describe("stageAgentMediaRevocation — directional split (#83 review)", () => {
  const fullMedia = {
    agentSubscribedMids: ["sub-1", "sub-2"],
    agentPublishedMid: "pub-1",
    tracks: [
      { trackName: "agent-voice", kind: "audio" as const },
      { trackName: "screen", kind: "video" as const },
    ],
  }

  it('"subscribed" (meeting-notes-stop / reassignment) closes only Human→Agent mids', () => {
    const agent = agentWithMedia(fullMedia)
    const pending = stageAgentMediaRevocation(agent, [], "subscribed")
    expect(agent.media?.agentSubscribedMids).toEqual([])
    // The independent voiceReply grant survives untouched: published mid AND
    // its room-visible audio track entry stay.
    expect(agent.media?.agentPublishedMid).toBe("pub-1")
    expect(agent.media?.tracks).toEqual([
      { trackName: "agent-voice", kind: "audio" },
      { trackName: "screen", kind: "video" },
    ])
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["sub-1", "sub-2"] },
    ])
  })

  it('"published" (voice-reply-stop / reassignment) closes only the Agent→Human mid and drops the room-visible voice track', () => {
    const agent = agentWithMedia(fullMedia)
    const pending = stageAgentMediaRevocation(agent, [], "published")
    // Independent Meeting Notes subscriptions survive untouched.
    expect(agent.media?.agentSubscribedMids).toEqual(["sub-1", "sub-2"])
    expect(agent.media?.agentPublishedMid).toBeUndefined()
    // Only the agent's own audio (its publication — agents can never use the
    // ordinary publish path) leaves the room-visible broadcast.
    expect(agent.media?.tracks).toEqual([
      { trackName: "screen", kind: "video" },
    ])
    expect(pending).toEqual([{ sessionId: "sess-agent", mids: ["pub-1"] }])
  })

  it('"both" (leave / lease expiry / S1→S2 rotation) tears down everything', () => {
    const agent = agentWithMedia(fullMedia)
    const pending = stageAgentMediaRevocation(agent, [], "both")
    expect(agent.media?.agentSubscribedMids).toEqual([])
    expect(agent.media?.agentPublishedMid).toBeUndefined()
    expect(agent.media?.tracks).toEqual([
      { trackName: "screen", kind: "video" },
    ])
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["sub-1", "sub-2", "pub-1"] },
    ])
  })

  it("a published mid already among the subscribed mids is queued exactly once", () => {
    const agent = agentWithMedia({
      ...fullMedia,
      agentPublishedMid: "sub-2",
    })
    const pending = stageAgentMediaRevocation(agent, [], "both")
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["sub-1", "sub-2"] },
    ])
  })

  it("staging merges into existing pending entries instead of duplicating them", () => {
    const agent = agentWithMedia({ agentSubscribedMids: ["sub-2"] })
    const pending = stageAgentMediaRevocation(
      agent,
      [{ sessionId: "sess-agent", mids: ["sub-1"] }],
      "subscribed"
    )
    expect(pending).toEqual([
      { sessionId: "sess-agent", mids: ["sub-1", "sub-2"] },
    ])
  })

  it("no-ops return the same queue reference when nothing matches the direction", () => {
    const existing = [{ sessionId: "sess-agent", mids: ["x"] }]
    expect(
      stageAgentMediaRevocation(agentWithMedia({}), existing, "published")
    ).toBe(existing)
    expect(stageAgentMediaRevocation(human(), existing, "both")).toBe(existing)
    expect(stageAgentMediaRevocation(undefined, existing, "both")).toBe(
      existing
    )
  })

  it("an agent with no media record is a cheap no-op (ordinary text-only agent)", () => {
    const textOnly: RoomParticipant = {
      id: "agent-2",
      name: "Text",
      kind: "agent",
      connected: true,
      joinedAt: 1,
      lastSeenAt: 1,
      token: "t",
    }
    const existing = [{ sessionId: "sess-agent", mids: ["x"] }]
    expect(stageAgentMediaRevocation(textOnly, existing, "both")).toBe(existing)
  })
})

describe("isHumanAudioTrackTarget (#83 review: agent subscribe targets are Human audio only)", () => {
  function participant(
    id: string,
    kind: "human" | "agent",
    sessionId: string,
    tracks: Array<{ trackName: string; kind: "audio" | "video" }>,
    extraMedia: Record<string, unknown> = {}
  ): RoomParticipant {
    return {
      id,
      name: id,
      kind,
      connected: true,
      joinedAt: 1,
      lastSeenAt: 1,
      token: "t",
      media: {
        sessionId,
        muted: false,
        fileChannelReady: false,
        tracks,
        ...extraMedia,
      },
    }
  }

  const room = {
    humanAudio: participant("h1", "human", "hsess", [
      { trackName: "mic", kind: "audio" },
    ]),
    humanVideo: participant("h2", "human", "vsess", [
      { trackName: "screen", kind: "video" },
    ]),
    agentVoice: participant(
      "a1",
      "agent",
      "asess",
      [{ trackName: "agent-voice", kind: "audio" }],
      { agentPublishedMid: "pub-1" }
    ),
  }

  it("admits a Human AUDIO track (the Meeting Notes ingress target)", () => {
    expect(isHumanAudioTrackTarget(room, "hsess", "mic")).toBe(true)
  })

  it("rejects a Human VIDEO (screen share) track even with known identifiers", () => {
    expect(isHumanAudioTrackTarget(room, "vsess", "screen")).toBe(false)
  })

  it("rejects another Agent's published voice track", () => {
    expect(isHumanAudioTrackTarget(room, "asess", "agent-voice")).toBe(false)
  })

  it("fails identically for unknown sessions/names (no existence oracle)", () => {
    expect(isHumanAudioTrackTarget(room, "nope", "mic")).toBe(false)
    expect(isHumanAudioTrackTarget(room, "hsess", "screen")).toBe(false)
  })
})
