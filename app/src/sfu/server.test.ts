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
    const fetchMock = vi.fn(async () =>
      Response.json({ sessionId: "cf-session-1" })
    )
    vi.stubGlobal("fetch", fetchMock)
    const env = makeEnv({ AGENT_MEDIA_ENABLED: "true" }, okDoResponder)
    const res = await handleSfuRequest(
      req("agent-session", { body: JSON.stringify(agentBody) }),
      env
    )
    expect(res.status).toBe(200)
    expect((await json(res)).sessionId).toBe("cf-session-1")
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
    fetchMock = vi.fn(async () =>
      Response.json({ sessionDescription: { type: "answer", sdp: "sdp" } })
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

  it("Agent + local audio track => 403 before any Cloudflare upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          agentTracksBody({
            location: "local",
            trackName: "audio-1",
            kind: "audio",
            mid: "0",
          })
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_publish_not_allowed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + local video track => 403 before any Cloudflare upstream call", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
    )
    const res = await handleSfuRequest(
      req("tracks", {
        body: JSON.stringify(
          agentTracksBody({
            location: "local",
            trackName: "video-1",
            kind: "video",
            mid: "1",
          })
        ),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_publish_not_allowed")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("Agent + a mix of one remote and one local track => still 403, nothing forwarded upstream", async () => {
    const env = makeEnv(
      { AGENT_MEDIA_ENABLED: "true" },
      doResponderForKind("agent")
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
            {
              location: "local",
              trackName: "audio-1",
              kind: "audio",
              mid: "0",
            },
          ],
          sessionDescription: { type: "offer", sdp: "sdp" },
        }),
      }),
      env
    )
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe("agent_publish_not_allowed")
    expect(fetchMock).not.toHaveBeenCalled()
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
    const fetchMock = vi.fn(async () => Response.json({ tracks: [] }))
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
