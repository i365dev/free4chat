import { describe, expect, it, vi } from "vitest"

import { handleMcpRequest, type McpEnv } from "./server"

function roomInfoRequest(id: number | string, roomId: string) {
  return new Request("https://www.free4.chat/mcp", {
    method: "POST",
    headers: {
      Origin: "https://www.free4.chat",
      Host: "www.free4.chat",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "room_info",
      "MCP-Protocol-Version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "room_info",
        arguments: { roomId },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  })
}

describe("MCP HTTP client isolation (GHSA-jm63-cq47-j5jp)", () => {
  it("rejects a modern request missing its protocol header before Room access", async () => {
    const request = roomInfoRequest(0, "room-a")
    request.headers.delete("MCP-Protocol-Version")
    const get = vi.fn()
    const response = await handleMcpRequest(
      request,
      { SFU_ROOM: { get }, ROOMS_KV: {} } as unknown as McpEnv,
      {} as ExecutionContext
    )
    expect(response.status).toBe(400)
    expect(get).not.toHaveBeenCalled()
  })

  it.each([0, "0"])(
    "keeps overlapping clients and subsequent requests isolated with id %j",
    async (id) => {
      let releaseSlow!: () => void
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve
      })
      let markSlowEntered!: () => void
      const slowEntered = new Promise<void>((resolve) => {
        markSlowEntered = resolve
      })
      const envFor = (client: string, slow = false) =>
        ({
          ROOMS_KV: {
            get: vi.fn(async () => null),
            put: vi.fn(async () => undefined),
          },
          SFU_ROOM: {
            idFromName: (room: string) => room,
            get: (room: string) => ({
              fetch: async () => {
                if (slow) {
                  markSlowEntered()
                  await slowGate
                }
                return Response.json({ roomId: room, client })
              },
            }),
          },
        } as unknown as McpEnv)
      const readResult = async (response: Response, client: string) => {
        expect(response.status).toBe(200)
        const payload = (await response.json()) as {
          id: number | string
          error?: unknown
          result: { isError?: boolean; content: Array<{ text: string }> }
        }
        expect(payload.id).toBe(id)
        expect(payload.error).toBeUndefined()
        expect(payload.result.isError).not.toBe(true)
        expect(JSON.parse(payload.result.content[0].text)).toEqual({
          roomId: `room-${client}`,
          client,
        })
      }

      // Hold A inside its tool while B uses the same JSON-RPC id. Exercise
      // the real Agents + SDK stack, including per-request auth context.
      const slowResponse = handleMcpRequest(
        roomInfoRequest(id, "room-a"),
        envFor("a", true),
        {} as ExecutionContext
      )
      await slowEntered
      try {
        await readResult(
          await handleMcpRequest(
            roomInfoRequest(id, "room-b"),
            envFor("b"),
            {} as ExecutionContext
          ),
          "b"
        )
      } finally {
        releaseSlow()
      }
      await readResult(await slowResponse, "a")

      // The SDK's reuse guards must not break the next ordinary request.
      await readResult(
        await handleMcpRequest(
          roomInfoRequest(id, "room-c"),
          envFor("c"),
          {} as ExecutionContext
        ),
        "c"
      )
    }
  )
})
