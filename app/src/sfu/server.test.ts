import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { handleSfuRequest, type SfuEnv } from "./server"

type DoResponder = (body: Record<string, unknown>) => {
  status: number
  body: unknown
}

function fakeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
  } as unknown as KVNamespace
}

function fakeSfuRoom(respond: DoResponder): SfuEnv["SFU_ROOM"] {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (_input: unknown, init?: RequestInit) => {
        const body = init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : {}
        const result = respond(body)
        return new Response(JSON.stringify(result.body), {
          status: result.status,
        })
      },
    }),
  } as unknown as SfuEnv["SFU_ROOM"]
}

const okDoResponder: DoResponder = () => ({ status: 200, body: { ok: true } })

// Responds to "authorize" with the given participant kind (as the real DO
// now does — see RoomSession.ts) and "ok" to everything else (publish,
// remote-track authorize, etc).
function doResponderForKind(kind: "human" | "agent"): DoResponder {
  return (body) => {
    if (body.action === "authorize")
      return { status: 200, body: { ok: true, kind } }
    return { status: 200, body: { ok: true } }
  }
}

function makeEnv(
  overrides: Partial<SfuEnv> = {},
  respond: DoResponder = okDoResponder
): SfuEnv {
  return {
    SFU_ROOM: fakeSfuRoom(respond),
    ROOMS_KV: fakeKV(),
    SFU_APP_ID: "app-id",
    SFU_APP_SECRET: "secret",
    ...overrides,
  }
}

function req(
  route: string,
  init: RequestInit & { origin?: string | null } = {}
): Request {
  const { origin, ...rest } = init
  const headers = new Headers(rest.headers)
  if (origin) headers.set("Origin", origin)
  return new Request(`https://example.com/api/sfu/${route}`, {
    method: "POST",
    ...rest,
    headers,
  })
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

const agentBody = {
  room: "room-1",
  participantId: "agent-1",
  token: "tok-1",
}

describe("AGENT_MEDIA_ENABLED gate", () => {
  it("agent-session rejects when the gate is unset (production default)", async () => {
    const env = makeEnv()
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_disabled")
  })

  it("agent-session rejects when the gate is explicitly false", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "false" })
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_disabled")
  })

  it("agent-room-media rejects when the gate is unset", async () => {
    const env = makeEnv()
    const res = await handleSfuRequest(
      req("agent-room-media", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_disabled")
  })

  it("agent-session proceeds past the gate when explicitly enabled, and still enforces agent auth", async () => {
    let requestedUrl: string | undefined
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return Response.json({ sessionId: "cf-session-1" })
    })
    vi.stubGlobal("fetch", fetchMock)
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, okDoResponder)
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(200)
    expect((await json(res)).sessionId).toBe("cf-session-1")
    expect(requestedUrl).toBe(
      "https://rtc.live.cloudflare.com/v1/apps/app-id/sessions/new"
    )
    vi.unstubAllGlobals()
  })

  it("agent-room-media proceeds past the gate when explicitly enabled", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, () => ({
      status: 200,
      body: { participants: [] },
    }))
    const res = await handleSfuRequest(
      req("agent-room-media", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(200)
    expect((await json(res)).participants).toEqual([])
  })

  it("an invalid Agent capability still rejects even with the gate enabled", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, () => ({
      status: 401,
      body: { error: "unauthorized" },
    }))
    const res = await handleSfuRequest(
      req("agent-room-media", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(401)
    expect((await json(res)).error).toBe("unauthorized")
  })
})

describe("Origin policy is route-scoped, not global", () => {
  // None of these tests care about the real Cloudflare Realtime response —
  // only about whether the Origin check itself rejects the request — so
  // stub fetch everywhere in this block to avoid any real network call.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ sessionId: "stub-session" }))
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const missingOriginAllowed = [
    "agent-session",
    "agent-room-media",
    "tracks",
    "renegotiate",
    "datachannels/establish",
  ]
  const missingOriginRejected = ["session"]

  for (const route of missingOriginAllowed) {
    it(`missing Origin is accepted on ${route} (non-browser Runtime route)`, async () => {
      const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" })
      const res = await handleSfuRequest(
        req(route, { body: JSON.stringify(agentBody) }),
        env
      )
      // May still fail validation for unrelated reasons (missing fields,
      // no SDP, etc.) — the only thing this asserts is that it was never
      // rejected specifically for a missing Origin.
      expect(res.status).not.toBe(403)
      if (res.status === 403)
        expect((await json(res)).error).not.toBe("forbidden_origin")
    })
  }

  for (const route of missingOriginRejected) {
    it(`missing Origin is rejected on ${route} (browser-only route)`, async () => {
      const env = makeEnv()
      const res = await handleSfuRequest(
        req(route, { body: JSON.stringify({ room: "r", name: "n" }) }),
        env
      )
      expect(res.status).toBe(403)
      expect((await json(res)).error).toBe("forbidden_origin")
    })
  }

  it("missing Origin is rejected on ws (browser-only route)", async () => {
    const env = makeEnv()
    const res = await handleSfuRequest(
      new Request(
        "https://example.com/api/sfu/ws?room=r&participantId=p&token=t",
        { method: "GET", headers: { Upgrade: "websocket" } }
      ),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("forbidden_origin")
  })

  it("a present-but-invalid Origin is always rejected, even on an agent-only route", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" })
    const res = await handleSfuRequest(
      req("agent-session", {
        body: JSON.stringify(agentBody),
        origin: "https://evil.example.com",
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("forbidden_origin")
  })

  it("a valid production Origin is still accepted on a Human-only route", async () => {
    const env = makeEnv()
    const res = await handleSfuRequest(
      req("session", {
        body: JSON.stringify({ room: "r", name: "n" }),
        origin: "https://www.free4.chat",
      }),
      env
    )
    // Rejected for other reasons (no Turnstile secret configured -> passes
    // verifyTurnstile trivially, so this should actually reach the SFU
    // credentials check) — the point is it must not be forbidden_origin.
    expect(res.status).not.toBe(403)
  })
})

describe("agent-session rate limiting", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ sessionId: "cf-session" }))
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("bounds repeated agent-session creation from the same caller", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" })
    const statuses: number[] = []
    // RATE_LIMIT_MAX is 20 in server.ts; 22 attempts guarantees at least
    // one rejection without hardcoding an exact boundary index.
    for (let i = 0; i < 22; i += 1) {
      const res = await handleSfuRequest(
        req("agent-session", {
          body: JSON.stringify(agentBody),
          headers: { "CF-Connecting-IP": "203.0.113.9" },
        }),
        env
      )
      statuses.push(res.status)
    }
    expect(statuses.some((status) => status === 429)).toBe(true)
    expect(statuses.filter((status) => status === 200).length).toBeLessThan(22)
  })

  it("does not share its rate-limit budget with Human /session creation", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" })
    // Exhaust the agent-session bucket only.
    for (let i = 0; i < 20; i += 1) {
      await handleSfuRequest(
        req("agent-session", {
          body: JSON.stringify(agentBody),
          headers: { "CF-Connecting-IP": "203.0.113.10" },
        }),
        env
      )
    }
    const agentRes = await handleSfuRequest(
      req("agent-session", {
        body: JSON.stringify(agentBody),
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      env
    )
    expect(agentRes.status).toBe(429)

    const humanRes = await handleSfuRequest(
      req("session", {
        body: JSON.stringify({ room: "r", name: "n" }),
        origin: "https://www.free4.chat",
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      env
    )
    expect(humanRes.status).not.toBe(429)
  })
})

describe("Phase-0 invariant: agent media sessions are subscribe-only", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Includes a `tracks[].mid` so an Agent's remote-subscription
    // mid-capture (Blocker 2's fail-closed check) has something usable —
    // matches Cloudflare's real tracks/new response shape, which always
    // assigns a mid.
    fetchMock = vi.fn(async () =>
      Response.json({
        sessionDescription: { type: "answer", sdp: "sdp" },
        tracks: [{ mid: "0" }],
      })
    )
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const humanTracksBody = (track: Record<string, unknown>) => ({
    room: "room-1",
    participantId: "human-1",
    token: "tok-1",
    sessionId: "sess-1",
    tracks: [track],
    sessionDescription: { type: "offer", sdp: "sdp" },
  })

  const agentTracksBody = (track: Record<string, unknown>) => ({
    room: "room-1",
    participantId: "agent-1",
    token: "tok-1",
    sessionId: "sess-1",
    tracks: [track],
    sessionDescription: { type: "offer", sdp: "sdp" },
  })

  it("Human + local audio track => allowed", async () => {
    const env = makeEnv({}, doResponderForKind("human"))
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          humanTracksBody({
            location: "local",
            trackName: "audio-1",
            kind: "audio",
            mid: "0",
          })
        ),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("Human + local video track => allowed", async () => {
    const env = makeEnv({}, doResponderForKind("human"))
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          humanTracksBody({
            location: "local",
            trackName: "video-1",
            kind: "video",
            mid: "1",
          })
        ),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("Human remote response with an offer does not perform publisher diagnostics", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)
    try {
      fetchMock = vi.fn(async () =>
        Response.json({
          sessionDescription: { type: "offer", sdp: "sdp" },
          tracks: [{ mid: "0" }],
        })
      )
      vi.stubGlobal("fetch", fetchMock)
      const env = makeEnv({}, doResponderForKind("human"))
      const res = await handleSfuRequest(
        req("tracks", {
          body: JSON.stringify(
            humanTracksBody({
              location: "remote",
              sessionId: "publisher-sess-1",
              trackName: "audio-human",
            })
          ),
        }),
        env
      )
      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("Human remote missing-description diagnostics preserve the original response and stay redacted", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/tracks/new"))
        return Response.json({
          requiresImmediateRenegotiation: true,
          errorCode: "track_lookup_failed",
          tracks: [{ errorCode: "track_not_found" }],
        })
      if (url.endsWith("/sessions/publisher-sess-1"))
        return new Response("upstream unavailable", { status: 503 })
      throw new Error("unexpected diagnostic request")
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const env = makeEnv({}, doResponderForKind("human"))
      const res = await handleSfuRequest(
        req("tracks", {
          body: JSON.stringify(
            humanTracksBody({
              location: "remote",
              sessionId: "publisher-sess-1",
              trackName: "audio-human",
            })
          ),
        }),
        env
      )
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({
        requiresImmediateRenegotiation: true,
        errorCode: "track_lookup_failed",
        tracks: [{ errorCode: "track_not_found" }],
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(String(fetchMock.mock.calls[1]![0])).toContain(
        "/sessions/publisher-sess-1"
      )
      const diagnosticCall = warnSpy.mock.calls.find(
        (call) => call[0] === "sfu_remote_subscribe_diagnostic"
      )
      expect(diagnosticCall?.[1]).toMatchObject({
        upstreamStatus: 200,
        requiresImmediateRenegotiation: true,
        hasSessionDescription: false,
        trackResultCount: 1,
        trackHasMid: false,
        topLevelErrorCode: "track_lookup_failed",
        trackErrorCodes: ["track_not_found"],
        publisherSessionLookupOk: false,
        publisherTrackCount: 0,
        matchingTrackFound: false,
        matchingTrackStatus: "unknown",
        matchingTrackHasMid: false,
      })
      expect(JSON.stringify(diagnosticCall)).not.toContain("publisher-sess-1")
      expect(JSON.stringify(diagnosticCall)).not.toContain("audio-human")
      expect(JSON.stringify(diagnosticCall)).not.toContain(
        "upstream unavailable"
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it.each([
    [
      "active",
      [{ trackName: "audio-human", status: "active", mid: "3" }],
      "active",
      true,
    ],
    [
      "inactive",
      [{ trackName: "audio-human", status: "inactive", mid: "3" }],
      "inactive",
      true,
    ],
    [
      "waiting",
      [{ trackName: "audio-human", status: "waiting", mid: "3" }],
      "waiting",
      true,
    ],
    [
      "missing",
      [{ trackName: "other-track", status: "active", mid: "3" }],
      "unknown",
      false,
    ],
  ])(
    "summarizes publisher status when Human remote response lacks an offer (%s)",
    async (_label, publisherTracks, expectedStatus, expectedFound) => {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined)
      fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith("/tracks/new"))
          return Response.json({ tracks: [{ errorCode: "track_not_found" }] })
        if (url.endsWith("/sessions/publisher-sess-1"))
          return Response.json({ tracks: publisherTracks })
        throw new Error("unexpected diagnostic request")
      })
      vi.stubGlobal("fetch", fetchMock)
      try {
        const env = makeEnv({}, doResponderForKind("human"))
        const res = await handleSfuRequest(
          req("tracks", {
            body: JSON.stringify(
              humanTracksBody({
                location: "remote",
                sessionId: "publisher-sess-1",
                trackName: "audio-human",
              })
            ),
          }),
          env
        )
        expect(res.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        const diagnosticCall = warnSpy.mock.calls.find(
          (call) => call[0] === "sfu_remote_subscribe_diagnostic"
        )
        expect(diagnosticCall?.[1]).toMatchObject({
          publisherSessionLookupOk: true,
          publisherTrackCount: 1,
          matchingTrackFound: expectedFound,
          matchingTrackStatus: expectedStatus,
          matchingTrackHasMid: expectedFound,
        })
      } finally {
        warnSpy.mockRestore()
      }
    }
  )

  it("Agent + remote Human audio track => allowed (subscribing is the whole point of Phase 0)", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          agentTracksBody({
            location: "remote",
            sessionId: "human-sess-1",
            trackName: "audio-human",
          })
        ),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  const voiceReplyTracksBody = (
    tracks: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {}
  ) => ({
    room: "room-1",
    participantId: "agent-1",
    token: "tok-1",
    sessionId: "sess-1",
    purpose: "voice-reply",
    tracks,
    sessionDescription: { type: "offer", sdp: "sdp" },
    ...overrides,
  })

  const localAudio = {
    location: "local",
    trackName: "agent-voice",
    kind: "audio",
    mid: "7",
  }

  it("Agent + local audio WITHOUT purpose => 403 agent_media_purpose_required before any upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          voiceReplyTracksBody([localAudio], { purpose: undefined })
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_purpose_required")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + local audio + wrong purpose meeting-notes => 403 agent_media_direction_forbidden before any upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          voiceReplyTracksBody([localAudio], { purpose: "meeting-notes" })
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_direction_forbidden")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + local VIDEO track => 403 agent_video_forbidden before any upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          voiceReplyTracksBody([
            {
              location: "local",
              trackName: "video-1",
              kind: "video",
              mid: "1",
            },
          ])
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_video_forbidden")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + TWO local audio tracks => 403 agent_publish_invalid_track_count before any upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          voiceReplyTracksBody([
            localAudio,
            { ...localAudio, trackName: "agent-voice-2", mid: "8" },
          ])
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_publish_invalid_track_count")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + mixed local+remote tracks => 403 agent_media_direction_forbidden before any upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          voiceReplyTracksBody([
            localAudio,
            {
              location: "remote",
              sessionId: "human-sess-1",
              trackName: "audio-human",
            },
          ])
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_direction_forbidden")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + local audio while AGENT_MEDIA_ENABLED is off => 403 agent_media_disabled before any upstream call", async () => {
    const env = makeEnv(undefined, doResponderForKind("agent"))
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(voiceReplyTracksBody([localAudio])),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_disabled")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + local audio without the voiceReply grant => DO rejection surfaced before any upstream call", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      if (body.action === "authorize")
        return { status: 403, body: { error: "voice_reply_not_authorized" } }
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(voiceReplyTracksBody([localAudio])),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("voice_reply_not_authorized")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Granted Agent + exactly one local audio track with purpose voice-reply => forwarded upstream once and booked via agent-track-published", async () => {
    const roomActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      roomActions.push(body)
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(voiceReplyTracksBody([localAudio])),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const upstreamUrl = String(fetchMock.mock.calls[0]![0])
    expect(upstreamUrl.endsWith("/sessions/sess-1/tracks/new")).toBe(true)
    expect(roomActions.map((action) => action.action)).toEqual([
      "agent-track-published",
    ])
    expect(roomActions[0]).toMatchObject({
      participantId: "agent-1",
      sessionId: "sess-1",
      mid: "0",
      trackName: "agent-voice",
    })
  })

  it("confirms an already-booked Agent publication only after Cloudflare reports it active", async () => {
    const roomActions: Array<Record<string, unknown>> = []
    fetchMock.mockResolvedValueOnce(
      Response.json({
        tracks: [{ trackName: "agent-voice", mid: "0", status: "active" }],
      })
    )
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      roomActions.push(body)
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("agent-track-active", {
        body: JSON.stringify({
          ...agentBody,
          sessionId: "sess-1",
          trackName: "agent-voice",
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(roomActions).toEqual([
      {
        action: "authorize",
        participantId: "agent-1",
        token: "tok-1",
        sessionId: "sess-1",
        purpose: "voice-reply",
        wantsVoicePublish: true,
      },
      {
        action: "agent-track-active",
        participantId: "agent-1",
        token: "tok-1",
        sessionId: "sess-1",
        trackName: "agent-voice",
      },
    ])
  })

  it("does not announce an Agent publication while Cloudflare still reports it inactive", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        tracks: [{ trackName: "agent-voice", mid: "0", status: "inactive" }],
      })
    )
    const roomActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      roomActions.push(body)
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("agent-track-active", {
        body: JSON.stringify({
          ...agentBody,
          sessionId: "sess-1",
          trackName: "agent-voice",
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect((await json(res)).active).toBe(false)
    expect(roomActions.map((action) => action.action)).toEqual(["authorize"])
  })

  it("does not affect renegotiate (no tracks array, route-scoped check)", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("renegotiate", {
        method: "PUT",
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-1",
          token: "tok-1",
          sessionId: "sess-1",
          sessionDescription: { type: "answer", sdp: "sdp" },
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
  })
})

// RoomSession.ts's "publish" action now also rejects an agent participant
// directly (`if (participant.kind === "agent") return this.json({ error:
// "agent_publish_not_allowed" }, 403)`, defense in depth alongside the
// route-level check above). It is NOT covered by an automated test here:
// RoomSession extends DurableObject from "cloudflare:workers", which
// doesn't exist outside the Workers runtime, so instantiating it needs
// @cloudflare/vitest-pool-workers — not set up in this project (the same
// pre-existing limitation documented on roomExpiry.ts, which was extracted
// as a pure function for exactly this reason). This defense-in-depth guard
// is verified by code review only; the enforced, tested boundary is the
// route-level check in the "Phase-0 invariant" suite above, which runs
// before RoomSession's "publish" action would ever be reached.

describe("Meeting Notes room grant is a real authorization boundary, not just token possession", () => {
  it("a generic MCP agent with a valid token but no Meeting Notes grant is still rejected", async () => {
    // Mirrors what RoomSession.ts's agent-room-media action actually does:
    // token/kind check passes, but the room grant check does not, so it
    // returns meeting_notes_not_authorized — this test proves the route
    // correctly surfaces that 403 rather than treating a valid token alone
    // as sufficient.
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, () => ({
      status: 403,
      body: { error: "meeting_notes_not_authorized" },
    }))
    const res = await handleSfuRequest(
      req("agent-room-media", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("meeting_notes_not_authorized")
  })

  it("agent-session also rejects an ungranted agent (it reuses the same auth check)", async () => {
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, () => ({
      status: 403,
      body: { error: "meeting_notes_not_authorized" },
    }))
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("meeting_notes_not_authorized")
  })
})

// Finding #2: revocation must apply to *every* subsequent Agent media
// operation, not just the initial agent-room-media discovery call — an
// Agent that already knows its own sessionId and a Human's
// sessionId/trackName from before Stop must not be able to keep creating
// subscriptions with those cached identifiers. /tracks and /renegotiate
// both gate on the DO's shared "authorize" action, so these tests simulate
// what the *fixed* DO now returns for a revoked agent (see RoomSession.ts's
// "authorize" action, which now also calls isAgentAuthorizedForMedia) and
// confirm the Worker correctly propagates that rejection instead of
// forwarding the request upstream to Cloudflare.
describe("Meeting Notes revocation blocks every subsequent Agent media operation, not just discovery", () => {
  const revokedAuthorizeResponder: DoResponder = (body) => {
    if (body.action === "authorize")
      return { status: 403, body: { error: "meeting_notes_not_authorized" } }
    return { status: 200, body: { ok: true } }
  }

  it("/tracks rejects a revoked agent even with a previously-valid sessionId/participantId", async () => {
    const fetchMock = vi.fn(async () => Response.json({ tracks: [] }))
    vi.stubGlobal("fetch", fetchMock)
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      revokedAuthorizeResponder
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-1",
          token: "tok-1",
          sessionId: "sess-1",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-1",
              trackName: "audio-human",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("meeting_notes_not_authorized")
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("/renegotiate rejects a revoked agent even with a previously-valid sessionId", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ sessionDescription: { type: "answer", sdp: "sdp" } })
    )
    vi.stubGlobal("fetch", fetchMock)
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      revokedAuthorizeResponder
    )
    const res = await handleSfuRequest(
      req("renegotiate", {
        method: "PUT",
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-1",
          token: "tok-1",
          sessionId: "sess-1",
          sessionDescription: { type: "answer", sdp: "sdp" },
        }),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("meeting_notes_not_authorized")
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("reassignment (A denied, B allowed) is exactly what the same authorize gate now enforces", async () => {
    // A is no longer the named agent -> its authorize() call now fails; B
    // is -> its authorize() call now succeeds. Modeled here as two separate
    // requests against two differently-configured fake DOs, mirroring how
    // RoomSession's single isAgentAuthorizedForMedia check would actually
    // answer each at that point in time.
    const fetchMock = vi.fn(async () =>
      Response.json({ tracks: [{ mid: "0" }] })
    )
    vi.stubGlobal("fetch", fetchMock)
    const deniedEnv = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      revokedAuthorizeResponder
    )
    const deniedRes = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-a",
          token: "tok-a",
          sessionId: "sess-a",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-1",
              trackName: "audio-human",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      deniedEnv
    )
    expect(deniedRes.status).toBe(403)

    const allowedEnv = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const allowedRes = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-b",
          token: "tok-b",
          sessionId: "sess-b",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-1",
              trackName: "audio-human",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      allowedEnv
    )
    expect(allowedRes.status).toBe(200)
    vi.unstubAllGlobals()
  })
})

// Blocker 2 (review round 3): the grant can be revoked/reassigned *between*
// the initial authorize() check and the agent-track-subscribed registration
// call completing (a TOCTOU window) — by which point Cloudflare has already
// created the subscription upstream. The commit must not report success in
// that case, and must actively close what Cloudflare already created.
describe("TOCTOU: the grant can be revoked between authorize() and subscription commit", () => {
  const agentRemoteBody = {
    room: "room-1",
    participantId: "agent-1",
    token: "tok-1",
    sessionId: "sess-1",
    tracks: [
      {
        location: "remote",
        sessionId: "human-sess-1",
        trackName: "audio-human",
      },
    ],
    sessionDescription: { type: "offer", sdp: "sdp" },
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("closes the newly-created mid and fails the request when registration is rejected", async () => {
    const closeCalls: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url)
      if (href.includes("/tracks/close")) {
        closeCalls.push(JSON.parse(init?.body as string))
        return new Response("", { status: 200 })
      }
      return Response.json({ tracks: [{ mid: "7" }] }) // tracks/new
    })
    vi.stubGlobal("fetch", fetchMock)
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      // The grant was revoked while tracks/new was in flight — registration
      // now correctly rejects even though authorize() passed moments ago.
      if (body.action === "agent-track-subscribed")
        return { status: 403, body: { error: "meeting_notes_not_authorized" } }
      return { status: 200, body: { ok: true } }
    })

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("meeting_notes_not_authorized")
    // The subscription Cloudflare already created is actively closed —
    // never left as an untracked, unrevocable subscription.
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0]).toMatchObject({ tracks: [{ mid: "7" }] })
    // No untracked Agent subscription remains: the DO never recorded the
    // mid as belonging to an authorized session (agent-track-subscribed
    // itself rejected), and it was actively closed upstream.
    expect(
      seenActions.some(
        (action) => action.action === "agent-media-cleanup-pending"
      )
    ).toBe(false)
  })

  it("queues bounded pending cleanup when the abort-path close itself does not confirm", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("/tracks/close"))
        return new Response("", { status: 500 })
      return Response.json({ tracks: [{ mid: "7" }] })
    })
    vi.stubGlobal("fetch", fetchMock)
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      if (body.action === "agent-track-subscribed")
        return { status: 403, body: { error: "meeting_notes_not_authorized" } }
      return { status: 200, body: { ok: true } }
    })

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(403)
    const pendingCall = seenActions.find(
      (action) => action.action === "agent-media-cleanup-pending"
    )
    expect(pendingCall).toBeDefined()
    expect(pendingCall?.mids).toEqual(["7"])
    expect(pendingCall?.sessionId).toBe("sess-1")
  })

  it("fails closed when the upstream response for an agent's remote track carries no usable mid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tracks: [{}] }))
    )
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe("agent_subscription_unverifiable")
  })

  it("fails closed when the upstream response is missing the tracks array entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}))
    )
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe("agent_subscription_unverifiable")
  })

  // Round 4: RoomSession must persist a revocation *before* attempting any
  // Cloudflare fetch, specifically so a concurrent /tracks request arriving
  // while that fetch is still in flight sees the *already-durable* revoked
  // grant — never a stale, pre-revocation grant that a later save could
  // resurrect. This models exactly that interleaving: Stop's own
  // Cloudflare tracks/close call is still pending (simulated by the DO's
  // "authorize" action already reflecting the revoked grant, since
  // RoomSession persists the revocation synchronously before ever touching
  // Cloudflare) when /tracks arrives for the same now-revoked agent.
  it("a /tracks request arriving while Stop's own Cloudflare close is still pending sees the already-persisted revocation, not a stale grant", async () => {
    const closeCalls: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url)
      if (href.includes("/tracks/close")) {
        closeCalls.push(JSON.parse(init?.body as string))
        return new Response("", { status: 200 })
      }
      return Response.json({ tracks: [{ mid: "9" }] }) // tracks/new
    })
    vi.stubGlobal("fetch", fetchMock)
    const seenActions: Array<Record<string, unknown>> = []
    // Models RoomSession *after* round 4's fix: the grant is already
    // revoked and persisted (so "authorize" rejects) well before Stop's own
    // Cloudflare close attempt (which this test's /tracks request races
    // against) ever resolves — there is no window where a concurrent
    // request could observe a stale "still granted" state.
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      if (body.action === "agent-track-subscribed")
        return { status: 403, body: { error: "meeting_notes_not_authorized" } }
      return { status: 200, body: { ok: true } }
    })

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(403)
    // The subscription this /tracks call itself just created upstream is
    // actively closed — it can never become an untracked, unrevocable
    // subscription regardless of how Stop's own (separate, concurrent)
    // cleanup attempt is progressing.
    expect(closeCalls).toHaveLength(1)
    expect(closeCalls[0]).toMatchObject({ tracks: [{ mid: "9" }] })
    expect(
      seenActions.some(
        (action) => action.action === "agent-media-cleanup-pending"
      )
    ).toBe(false)
  })
})

// Finding #3: an Agent's remote-track subscriptions must be closeable
// server-side later (Stop, reassignment, leave, lease expiry all actively
// terminate already-flowing RTP, not just block future subscriptions) —
// which requires knowing the Cloudflare-assigned mid for each one. This
// suite proves the Worker captures that mid from the upstream tracks/new
// response and hands it to the DO via "agent-track-subscribed", scoped to
// agent-kind callers only.
describe("Agent remote-track subscriptions register their assigned mids for later revocation", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("records the upstream-assigned mid for an agent's remote subscription", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tracks: [{ mid: "5" }] }))
    )
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-1",
          token: "tok-1",
          sessionId: "sess-1",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-1",
              trackName: "audio-human",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    const registerCall = seenActions.find(
      (action) => action.action === "agent-track-subscribed"
    )
    expect(registerCall).toBeDefined()
    expect(registerCall?.mids).toEqual(["5"])
    expect(registerCall?.sessionId).toBe("sess-1")
    expect(registerCall?.participantId).toBe("agent-1")
  })

  it("does not register anything for a Human's own remote subscription", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tracks: [{ mid: "5" }] }))
    )
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({}, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "human" } }
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "human-1",
          token: "tok-1",
          sessionId: "sess-1",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-2",
              trackName: "audio-2",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(
      seenActions.some((action) => action.action === "agent-track-subscribed")
    ).toBe(false)
  })
})

// Round 5, P1: the Worker's initial agent-room-media check before creating
// a Cloudflare session is not enough on its own — /sessions/new is external
// I/O, during which the Human can Stop or reassign Meeting Notes. The DO's
// agent-media-attach action re-checks the grant itself and must reject the
// attach (never silently rotating the participant into a new "active"
// media session) if it's no longer valid — this proves the Worker's
// /agent-session route correctly surfaces that rejection instead of
// returning the newly-created (but never attached) sessionId.
//
// The deeper DO-internal behavior this finding also requires — rotating an
// existing Agent session (S1 -> S2) must move S1's already-tracked
// agentSubscribedMids into pendingMediaCleanup rather than silently
// forgetting them — is implemented by reusing stageAgentMediaRevocation
// (see RoomSession.ts's "agent-media-attach" action) and, like RoomSession's
// other internal state transitions, cannot be exercised here: RoomSession
// extends DurableObject from "cloudflare:workers", which doesn't exist
// outside the Workers runtime, so this project (no
// @cloudflare/vitest-pool-workers) can't instantiate it directly — the same
// pre-existing limitation documented throughout this file. It reuses
// queuePendingCleanup/attemptCleanupNow's own pattern, already covered by
// realtimeMedia.test.ts and the interleaving-safety tests above; verified
// by code review here.
describe("agent-session rejects when the grant is no longer valid by the time attach runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("propagates agent-media-attach's rejection instead of returning the orphaned sessionId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ sessionId: "cf-session-1" }))
    )
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "agent-room-media")
        return { status: 200, body: { participants: [] } }
      // The grant was revoked/reassigned while /sessions/new was in
      // flight — agent-media-attach's own re-check now rejects.
      if (body.action === "agent-media-attach")
        return { status: 403, body: { error: "meeting_notes_not_authorized" } }
      return { status: 200, body: { ok: true } }
    })

    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )

    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("meeting_notes_not_authorized")
    expect(seenActions.some((a) => a.action === "agent-media-attach")).toBe(
      true
    )
  })
})

// Round 5, P2: reject a backpressured room *before* ever calling
// Cloudflare's tracks/new for an Agent's remote subscriptions — not just
// after, via agent-track-subscribed's own capacity check (round 4). The
// Worker now tells the DO's "authorize" action how many new remote-
// subscribe tracks this request would create, so a room that's already at
// capacity is rejected without ever creating (and then immediately having
// to close) yet another upstream Cloudflare subscription.
describe("preflight capacity check runs before Cloudflare tracks/new (round 5, P2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const agentRemoteBody = {
    room: "room-1",
    participantId: "agent-1",
    token: "tok-1",
    sessionId: "sess-1",
    tracks: [
      {
        location: "remote",
        sessionId: "human-sess-1",
        trackName: "audio-human",
      },
    ],
    sessionDescription: { type: "offer", sdp: "sdp" },
  }

  it("rejects before calling Cloudflare when the DO's preflight reports capacity exhausted", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ tracks: [{ mid: "1" }] })
    )
    vi.stubGlobal("fetch", fetchMock)
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 503, body: { error: "agent_media_cleanup_backlog" } }
      return { status: 200, body: { ok: true } }
    })

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(503)
    expect((await json(res)).error).toBe("agent_media_cleanup_backlog")
    // Cloudflare's tracks/new must never be reached once the preflight
    // already rejected — creating the subscription only to immediately
    // fail to register it would just grow the very backlog that caused
    // the rejection.
    expect(fetchMock).not.toHaveBeenCalled()
    const authorizeCall = seenActions.find((a) => a.action === "authorize")
    expect(authorizeCall?.remoteTrackCount).toBe(1)
  })

  it("rejects before calling Cloudflare when the preflight reports active-mid capacity exhausted", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ tracks: [{ mid: "1" }] })
    )
    vi.stubGlobal("fetch", fetchMock)
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      if (body.action === "authorize")
        return { status: 503, body: { error: "agent_media_capacity_exceeded" } }
      return { status: 200, body: { ok: true } }
    })

    const res = await handleSfuRequest(
      req("tracks", { body: JSON.stringify(agentRemoteBody) }),
      env
    )

    expect(res.status).toBe(503)
    expect((await json(res)).error).toBe("agent_media_capacity_exceeded")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("passes remoteTrackCount for a multi-track request and 0 for a Human's own request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tracks: [{ mid: "1" }, { mid: "2" }] }))
    )
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      return { status: 200, body: { ok: true } }
    })

    await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-1",
          token: "tok-1",
          sessionId: "sess-1",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-1",
              trackName: "audio-1",
            },
            {
              location: "remote",
              sessionId: "human-sess-2",
              trackName: "audio-2",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      env
    )

    const authorizeCall = seenActions.find((a) => a.action === "authorize")
    expect(authorizeCall?.remoteTrackCount).toBe(2)
    vi.unstubAllGlobals()

    seenActions.length = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tracks: [{ mid: "1" }] }))
    )
    const humanEnv = makeEnv({}, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "human" } }
      return { status: 200, body: { ok: true } }
    })
    await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify({
          room: "room-1",
          participantId: "human-1",
          token: "tok-1",
          sessionId: "sess-1",
          tracks: [
            {
              location: "remote",
              sessionId: "human-sess-2",
              trackName: "audio-2",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      humanEnv
    )
    const humanAuthorizeCall = seenActions.find((a) => a.action === "authorize")
    expect(humanAuthorizeCall?.remoteTrackCount).toBe(1) // sent regardless of kind — the DO only *acts* on it for agent-kind callers
  })

  it("does not send a nonzero remoteTrackCount for renegotiate (no new tracks)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ sessionDescription: { type: "answer", sdp: "sdp" } })
      )
    )
    const seenActions: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(body)
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      return { status: 200, body: { ok: true } }
    })

    await handleSfuRequest(
      req("renegotiate", {
        method: "PUT",
        body: JSON.stringify({
          room: "room-1",
          participantId: "agent-1",
          token: "tok-1",
          sessionId: "sess-1",
          sessionDescription: { type: "answer", sdp: "sdp" },
        }),
      }),
      env
    )

    const authorizeCall = seenActions.find((a) => a.action === "authorize")
    expect(authorizeCall?.remoteTrackCount).toBe(0)
  })
})

describe("#83 review: shared Agent session admission is MN OR VR (agent-media-admit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("agent-session admits through agent-media-admit and never touches Human media discovery", async () => {
    const seenActions: string[] = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(String(body.action))
      return { status: 200, body: { ok: true, expiresAt: Date.now() } }
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ sessionId: "cf-session-vr" }))
    )
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(200)
    expect((await json(res)).sessionId).toBe("cf-session-vr")
    expect(seenActions).toContain("agent-media-admit")
    expect(seenActions).toContain("agent-media-attach")
    expect(seenActions).not.toContain("agent-room-media")
  })

  it("a room where neither grant names the agent fails closed before any Cloudflare spend", async () => {
    let cloudflareCalled = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        cloudflareCalled = true
        return Response.json({ sessionId: "should-not-happen" })
      })
    )
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) =>
      body.action === "agent-media-admit"
        ? { status: 403, body: { error: "agent_media_not_authorized" } }
        : { status: 200, body: { ok: true } }
    )
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_media_not_authorized")
    expect(cloudflareCalled).toBe(false)
  })

  it("agent-room-media keeps using the Meeting-Notes-only discovery action", async () => {
    const seenActions: string[] = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      seenActions.push(String(body.action))
      return { status: 200, body: { participants: [] } }
    })
    const res = await handleSfuRequest(
      req("agent-room-media", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(200)
    expect(seenActions).toEqual(["agent-room-media"])
  })
})

describe("#83 review: purpose reaches every DO authorize along the real path", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function recordingEnv() {
    const authorizations: Array<Record<string, unknown>> = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      if (body.action === "authorize") {
        authorizations.push(body)
        return { status: 200, body: { ok: true, kind: "agent" } }
      }
      return { status: 200, body: { ok: true } }
    })
    return { authorizations, env }
  }

  it("datachannels/establish forwards the typed transport purpose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ sessionDescription: {} }))
    )
    const { authorizations, env } = recordingEnv()
    const res = await handleSfuRequest(
      req("datachannels/establish", {
        body: JSON.stringify({
          ...agentBody,
          sessionId: "sess-a",
          purpose: "agent-transport",
          dataChannel: { location: "remote", dataChannelName: "server-events" },
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(authorizations).toHaveLength(1)
    expect(authorizations[0].purpose).toBe("agent-transport")
  })

  it("tracks re-authorizes EACH remote track with the request purpose (remote-track reauth)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          tracks: [{ mid: "mid-a" }, { mid: "mid-b" }],
        })
      )
    )
    const { authorizations, env } = recordingEnv()
    const res = await handleSfuRequest(
      req("tracks", {
        method: "POST",
        body: JSON.stringify({
          ...agentBody,
          sessionId: "sess-a",
          purpose: "meeting-notes",
          tracks: [
            {
              location: "remote",
              sessionId: "human-1",
              trackName: "mic",
            },
            {
              location: "remote",
              sessionId: "human-2",
              trackName: "mic",
            },
          ],
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    const reauths = authorizations.filter(
      (auth) => auth.trackSessionId !== undefined
    )
    expect(reauths).toHaveLength(2)
    expect(reauths[0].purpose).toBe("meeting-notes")
    expect(reauths[1].purpose).toBe("meeting-notes")
    expect(reauths[0].trackName).toBe("mic")
  })

  it("renegotiate forwards its purpose to the DO authorize", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}))
    )
    const { authorizations, env } = recordingEnv()
    const res = await handleSfuRequest(
      req("renegotiate", {
        method: "PUT",
        body: JSON.stringify({
          ...agentBody,
          sessionId: "sess-a",
          purpose: "voice-reply",
          sessionDescription: { type: "answer", sdp: "v=0\r\n" },
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(authorizations).toHaveLength(1)
    expect(authorizations[0].purpose).toBe("voice-reply")
  })
})

describe("#83 review: Agent datachannel access is bootstrap-only over the shared session", () => {
  function agentDataChannelEnv() {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ ok: true })
    )
    vi.stubGlobal("fetch", fetchMock)
    const seenActions: string[] = []
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      if (body.action === "authorize")
        return { status: 200, body: { ok: true, kind: "agent" } }
      seenActions.push(String(body.action))
      return { status: 200, body: { ok: true } }
    })
    return { fetchMock, env }
  }

  const baseBody = {
    ...agentBody,
    sessionId: "sess-a",
    purpose: "agent-transport",
  }
  const origin = { origin: "https://www.free4.chat" }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("datachannels/new is forbidden for an Agent before any Cloudflare call", async () => {
    const { fetchMock, env } = agentDataChannelEnv()
    const res = await handleSfuRequest(
      req("datachannels/new", {
        ...origin,
        body: JSON.stringify({
          ...baseBody,
          dataChannels: [{ location: "remote", dataChannelName: "anything" }],
        }),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_datachannel_forbidden")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("establish with anything but the exact server-events shape fails closed", async () => {
    const { fetchMock, env } = agentDataChannelEnv()
    for (const dataChannel of [
      { location: "remote", dataChannelName: "other-channel" },
      { location: "local", dataChannelName: "server-events" },
      { location: "remote" },
    ]) {
      const res = await handleSfuRequest(
        req("datachannels/establish", {
          ...origin,
          body: JSON.stringify({
            ...baseBody,
            dataChannel,
            sessionDescription: { type: "offer", sdp: "v=0\r\n" },
          }),
        }),
        env
      )
      expect(res.status).toBe(403)
      expect((await json(res)).error).toBe("agent_datachannel_shape_forbidden")
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("the exact server-events establish still reaches Cloudflare", async () => {
    const { fetchMock, env } = agentDataChannelEnv()
    const res = await handleSfuRequest(
      req("datachannels/establish", {
        ...origin,
        body: JSON.stringify({
          ...baseBody,
          dataChannel: { location: "remote", dataChannelName: "server-events" },
          sessionDescription: { type: "offer", sdp: "v=0\r\n" },
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/sessions/sess-a/datachannels/establish"
    )
  })

  it("close stays available to Agents for cleaning up the established channel", async () => {
    const { fetchMock, env } = agentDataChannelEnv()
    const res = await handleSfuRequest(
      req("datachannels/close", {
        ...origin,
        method: "PUT",
        body: JSON.stringify({
          ...baseBody,
          publisherSessionId: "human-sess",
          dataChannels: [{ id: 1, sessionId: "human-sess" }],
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/sessions/sess-a/datachannels/close"
    )
  })
})

describe("#83 review P1: datachannels/close authorize parameter mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("the main and per-channel authorizes carry purpose AND the right dataChannelSessionId", async () => {
    const authorizations: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ ok: true })
    )
    vi.stubGlobal("fetch", fetchMock)
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, (body) => {
      if (body.action === "authorize") {
        authorizations.push(body)
        return { status: 200, body: { ok: true, kind: "agent" } }
      }
      return { status: 200, body: { ok: true } }
    })
    const res = await handleSfuRequest(
      req("datachannels/close", {
        origin: "https://www.free4.chat",
        method: "PUT",
        body: JSON.stringify({
          ...agentBody,
          sessionId: "sess-a",
          purpose: "agent-transport",
          publisherSessionId: "human-pub",
          dataChannels: [
            { id: 1, sessionId: "human-pub" },
            { id: 2, sessionId: "human-other" },
          ],
        }),
      }),
      env
    )
    expect(res.status).toBe(200)
    expect(authorizations.length).toBe(3)
    // Main correlation = publisher session.
    expect(authorizations[0].dataChannelSessionId).toBe("human-pub")
    expect(authorizations[0].purpose).toBe("agent-transport")
    // Each channel is re-correlated to ITS owning session, same purpose.
    expect(authorizations[1].dataChannelSessionId).toBe("human-pub")
    expect(authorizations[2].dataChannelSessionId).toBe("human-other")
    expect(authorizations[1].purpose).toBe("agent-transport")
    expect(authorizations[2].purpose).toBe("agent-transport")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
