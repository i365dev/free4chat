import { describe, expect, it } from "vitest"

import { handleMcpRequest, type McpEnv } from "./server"

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
  })
})
