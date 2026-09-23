import { describe, expect, it, vi } from "vitest"

import { handleMcpRequest, type McpEnv } from "./server"
import { RoomSession } from "../do/RoomSession"

describe("public MCP tool surface", () => {
  it("does not expose Runtime provider connection or its private handle", async () => {
    const request = new Request("https://www.free4.chat/mcp", {
      method: "POST",
      headers: {
        Origin: "https://www.free4.chat",
        Host: "www.free4.chat",
        "Content-Type": "application/json",
        Accept: "application/json",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
    const response = await handleMcpRequest(
      request,
      { SFU_ROOM: {}, ROOMS_KV: {} } as McpEnv,
      {} as ExecutionContext
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ name?: string }> }
    }
    const names = payload.result?.tools?.map((tool) => tool.name) ?? []
    expect(names).not.toContain("connect_runtime_provider")
    expect(names).not.toContain("runtimeProviderHandle")
    expect(names).toContain("read_room_context")
    expect(names).toContain("publish_live_view")
    expect(names).toContain("publish_generated_app")
    expect(names).toHaveLength(19)
  })

  it("preserves legacy Room ids and the server Agent lease", async () => {
    const leaseMs = 90_000
    const sessions = new Map<string, RoomSession>()
    const sessionFor = (room: string) => {
      const existing = sessions.get(room)
      if (existing) return existing
      const store = new Map<string, unknown>()
      const session = new RoomSession(
        {
          storage: {
            get: async (key: string) => store.get(key),
            put: async (key: string, value: unknown) =>
              void store.set(key, value),
            delete: async (keys: string | string[]) => {
              for (const key of Array.isArray(keys) ? keys : [keys])
                store.delete(key)
            },
            setAlarm: async () => undefined,
            deleteAlarm: async () => undefined,
            getAlarm: async () => undefined,
          },
          getWebSockets: () => [],
          waitUntil: (promise: Promise<unknown>) => void promise,
          id: { toString: () => room, name: room },
        } as never,
        { SFU_ROOM: {} } as never
      )
      sessions.set(room, session)
      return session
    }
    const env = {
      ROOMS_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      },
      SFU_ROOM: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: (input: string | Request, init?: RequestInit) =>
            sessionFor(id).fetch(new Request(input, init)),
        }),
      },
    } as unknown as McpEnv

    const callTool = async (
      name: string,
      arguments_: Record<string, string>
    ) => {
      const response = await handleMcpRequest(
        new Request("https://www.free4.chat/mcp", {
          method: "POST",
          headers: {
            Origin: "https://www.free4.chat",
            Host: "www.free4.chat",
            "Content-Type": "application/json",
            Accept: "application/json",
            "Mcp-Method": "tools/call",
            "Mcp-Name": name,
            "MCP-Protocol-Version": "2026-07-28",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name,
              arguments: arguments_,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        env,
        {} as ExecutionContext
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        result?: { content?: Array<{ type?: string; text?: string }> }
      }
      const text = payload.result?.content?.find(
        (block) => block.type === "text"
      )?.text
      return JSON.parse(text ?? "{}") as Record<string, unknown>
    }

    const uuidRoomId = "123e4567-e89b-42d3-a456-426614174000"
    const legacyRoomId = "room-239"
    const joined = await callTool("join_room", {
      roomId: uuidRoomId,
      name: "Join Agent",
    })
    const legacyJoined = await callTool("join_room", {
      roomId: legacyRoomId,
      name: "Legacy Agent",
    })
    const created = await callTool("create_room", {
      name: "Create Agent",
    })
    expect(joined.agentLeaseMs).toBe(leaseMs)
    expect(legacyJoined.agentLeaseMs).toBe(leaseMs)
    expect(created.agentLeaseMs).toBe(leaseMs)
    expect(created.invite).toMatchObject({
      roomId: expect.stringMatching(
        /^[a-z]+-[a-z]+-[23456789abcdefghjkmnpqrstuvwxyz]{12}$/
      ),
    })
    expect((created.invite as { roomUrl: string }).roomUrl).toContain(
      encodeURIComponent((created.invite as { roomId: string }).roomId)
    )
    expect(sessions.has(uuidRoomId)).toBe(true)
    expect(sessions.has(legacyRoomId)).toBe(true)
    expect(sessions.size).toBe(3)
  })

  it("retries a cosmic Room id collision without joining the first id", async () => {
    const attemptedRoomIds: string[] = []
    let attempts = 0
    let entropyCalls = 0
    const entropy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((array) => {
        const value = entropyCalls < 14 ? 0 : 0x80000000
        entropyCalls += 1
        const values = array as Uint32Array
        values.fill(value)
        return array
      })
    const env = {
      ROOMS_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      },
      SFU_ROOM: {
        idFromName: (name: string) => {
          attemptedRoomIds.push(name)
          return name
        },
        get: () => ({
          fetch: async () => {
            attempts += 1
            if (attempts === 1) {
              return new Response(
                JSON.stringify({ error: "room_already_exists" }),
                {
                  status: 409,
                  headers: { "Content-Type": "application/json" },
                }
              )
            }
            return new Response(
              JSON.stringify({
                participant: { id: "agent-1", name: "Pi", kind: "agent" },
                cursor: 0,
                expiresAt: 0,
                agentLeaseMs: 90_000,
              }),
              { headers: { "Content-Type": "application/json" } }
            )
          },
        }),
      },
    } as unknown as McpEnv
    try {
      const response = await handleMcpRequest(
        new Request("https://www.free4.chat/mcp", {
          method: "POST",
          headers: {
            Origin: "https://www.free4.chat",
            Host: "www.free4.chat",
            "Content-Type": "application/json",
            Accept: "application/json",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "create_room",
            "MCP-Protocol-Version": "2026-07-28",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "create_room",
              arguments: { name: "Pi" },
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        env,
        {} as ExecutionContext
      )
      const payload = (await response.json()) as {
        result?: { content?: Array<{ type?: string; text?: string }> }
      }
      const result = JSON.parse(
        payload.result?.content?.find((block) => block.type === "text")?.text ??
          "{}"
      ) as { invite?: { roomId?: string } }

      expect(response.status).toBe(200)
      expect(attempts).toBe(2)
      expect(attemptedRoomIds).toHaveLength(2)
      expect(attemptedRoomIds[0]).not.toBe(attemptedRoomIds[1])
      expect(result.invite?.roomId).toBe(attemptedRoomIds[1])
    } finally {
      entropy.mockRestore()
    }
  })
})

// #406: MCP admission uses the Cloudflare Workers Rate Limiting binding
// (never the KV get/put counter), and the one unauthenticated Room-probing
// tool is rejected before any Durable Object is contacted.
describe("MCP admission throttle and pre-DO Room probe guard", () => {
  function fakeLimiter(success: boolean) {
    const keys: string[] = []
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key)
        return { success }
      },
    }
    return { keys, limiter }
  }

  // A handle is only base64url JSON — it proves nothing, which is exactly why
  // the guard has to run before any Room is resolved.
  function encodeForgedHandle(room: string) {
    return btoa(
      JSON.stringify({
        room,
        participantId: "forged-participant",
        participantToken: "garbage",
      })
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
  }

  function harness(
    env: Record<string, unknown>,
    options: {
      controlResponse?: (action: unknown) => Response | null
    } = {}
  ) {
    const roomCalls: Array<{ room: string; action: unknown }> = []
    const kvGet = vi.fn(async () => null)
    const kvPut = vi.fn(async () => undefined)
    const fullEnv = {
      ROOMS_KV: { get: kvGet, put: kvPut },
      SFU_ROOM: {
        idFromName: (name: string) => name,
        get: (id: string) => ({
          fetch: async (input: string | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.url
            const body = init?.body
              ? (JSON.parse(String(init.body)) as { action?: unknown })
              : {}
            roomCalls.push({ room: id, action: body.action })
            if (body.action === "room-info")
              return Response.json({ exists: true, participants: [] })
            const override = options.controlResponse?.(body.action)
            if (override) return override
            return Response.json({
              participant: { id: "participant-1", name: "Agent" },
              cursor: 0,
              expiresAt: Date.now() + 60_000,
              agentLeaseMs: 90_000,
            })
          },
        }),
      },
      ...env,
    } as unknown as McpEnv
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const response = await handleMcpRequest(
        new Request("https://www.free4.chat/mcp", {
          method: "POST",
          headers: {
            Origin: "https://www.free4.chat",
            Host: "www.free4.chat",
            "Content-Type": "application/json",
            Accept: "application/json",
            "Mcp-Method": "tools/call",
            "Mcp-Name": name,
            "MCP-Protocol-Version": "2026-07-28",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name,
              arguments: args,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        fullEnv,
        {} as ExecutionContext
      )
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        result?: { content?: Array<{ type?: string; text?: string }> }
      }
      const text = payload.result?.content?.find(
        (block) => block.type === "text"
      )?.text
      return JSON.parse(text ?? "{}") as Record<string, unknown>
    }
    return { callTool, roomCalls, kvGet, kvPut }
  }

  it("rejects an abusive room_info probe before the Durable Object is contacted", async () => {
    const { keys, limiter } = fakeLimiter(false)
    const { callTool, roomCalls } = harness({
      ROOM_PROBE_RATE_LIMITER: limiter,
    })

    const result = await callTool("room_info", { roomId: "room-1" })

    expect(result).toEqual({ error: "rate_limited" })
    expect(roomCalls).toEqual([])
    expect(keys).toEqual(["mcp:room_info:rl:unknown"])
  })

  it("still serves a legitimate room_info observation", async () => {
    const { limiter } = fakeLimiter(true)
    const { callTool, roomCalls } = harness({
      ROOM_PROBE_RATE_LIMITER: limiter,
    })

    const result = await callTool("room_info", { roomId: "room-1" })

    expect(result.exists).toBe(true)
    expect(roomCalls).toEqual([{ room: "room-1", action: "room-info" }])
  })

  it("throttles join_room and create_room with the binding, never with KV", async () => {
    const { keys, limiter } = fakeLimiter(true)
    const { callTool, kvGet, kvPut } = harness({
      MCP_JOIN_RATE_LIMITER: limiter,
    })

    const joined = await callTool("join_room", {
      roomId: "room-1",
      name: "Join Agent",
    })
    const created = await callTool("create_room", { name: "Create Agent" })

    expect(joined.agentLeaseMs).toBe(90_000)
    expect(created.agentLeaseMs).toBe(90_000)
    expect(keys).toEqual(["mcp:join:rl:unknown", "mcp:join:rl:unknown"])
    expect(kvGet).not.toHaveBeenCalled()
    expect(kvPut).not.toHaveBeenCalled()
  })

  // #406: decodeHandle proves nothing, so EVERY handle-bearing tool resolves
  // its Room before the token can be checked. One shared guard must cover them
  // all, otherwise a forged handle just switches tool name or roomId.
  it("rejects a forged handle on any handle-bearing tool before the DO is contacted", async () => {
    const { limiter } = fakeLimiter(false)
    const { callTool, roomCalls } = harness({
      MCP_HANDLE_RATE_LIMITER: limiter,
    })
    const forged = encodeForgedHandle("random-room-000001")

    const waited = await callTool("wait_for_events", {
      participantHandle: forged,
      cursor: 0,
      timeoutSeconds: 0,
    })
    const sent = await callTool("send_text", {
      participantHandle: forged,
      text: "hello",
    })
    const surface = await callTool("read_surface", {
      participantHandle: forged,
      sourceParticipantId: "someone",
      snapshotId: "snapshot-1",
    })

    expect(waited).toEqual({ error: "rate_limited" })
    expect(sent).toEqual({ error: "rate_limited" })
    expect(surface).toEqual({ error: "rate_limited" })
    // Nothing reached any RoomSession: no DO invocation for any roomId.
    expect(roomCalls).toEqual([])
  })

  it("still serves a legitimate handle when the guard allows it", async () => {
    const { limiter } = fakeLimiter(true)
    const { callTool, roomCalls } = harness({
      MCP_HANDLE_RATE_LIMITER: limiter,
    })

    const result = await callTool("wait_for_events", {
      participantHandle: encodeForgedHandle("room-1"),
      cursor: 0,
      timeoutSeconds: 0,
    })

    expect(result.cursor).toBe(0)
    expect(roomCalls).toEqual([{ room: "room-1", action: "agent-wait" }])
  })

  it("enforces a wait cadence before the DO and reports retryAfterMs", async () => {
    const { limiter } = fakeLimiter(false)
    const { callTool, roomCalls } = harness({ MCP_WAIT_RATE_LIMITER: limiter })

    const result = await callTool("wait_for_events", {
      participantHandle: encodeForgedHandle("room-1"),
      cursor: 0,
      timeoutSeconds: 25,
    })

    expect(result).toEqual({ error: "wait_rate_limited", retryAfterMs: 10_000 })
    expect(roomCalls).toEqual([])
  })

  it("surfaces the DO-side wait cadence backstop with its own retryAfterMs", async () => {
    const { limiter } = fakeLimiter(true)
    const { callTool, roomCalls } = harness(
      { MCP_WAIT_RATE_LIMITER: limiter, MCP_HANDLE_RATE_LIMITER: limiter },
      {
        controlResponse: (action) =>
          action === "agent-wait"
            ? Response.json(
                { error: "wait_rate_limited", retryAfterMs: 4_200 },
                { status: 429 }
              )
            : null,
      }
    )

    const result = await callTool("wait_for_events", {
      participantHandle: encodeForgedHandle("room-1"),
      cursor: 0,
      timeoutSeconds: 25,
    })

    expect(result).toEqual({ error: "wait_rate_limited", retryAfterMs: 4_200 })
    expect(roomCalls).toHaveLength(1)
  })

  it("rejects an over-budget join before the Durable Object is contacted", async () => {
    const { limiter } = fakeLimiter(false)
    const { callTool, roomCalls } = harness({ MCP_JOIN_RATE_LIMITER: limiter })

    const result = await callTool("join_room", {
      roomId: "room-1",
      name: "Join Agent",
    })

    expect(result).toEqual({ error: "rate_limited" })
    expect(roomCalls).toEqual([])
  })
})
