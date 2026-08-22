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
