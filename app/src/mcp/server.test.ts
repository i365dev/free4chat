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
    expect(names).toHaveLength(17)
  })

  it("preserves the server Agent lease through join_room and create_room", async () => {
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

    const joined = await callTool("join_room", {
      roomId: "room-239",
      name: "Join Agent",
    })
    const created = await callTool("create_room", {
      name: "Create Agent",
    })
    expect(joined.agentLeaseMs).toBe(leaseMs)
    expect(created.agentLeaseMs).toBe(leaseMs)
    expect(sessions.size).toBe(2)
  })
})
