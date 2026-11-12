import { describe, expect, it, vi } from "vitest"

import { handleMcpRequest, type McpEnv } from "./server"

const runtimeHost = {
  runtimeHostId: "validation-host-123456",
  speech: { stt: false, tts: false },
}
const capability = {
  capabilityId: "fixture",
  title: "Fixture",
  version: "1",
  observe: true,
  actions: [],
}
const action = {
  name: "run",
  title: "Run",
  input: { type: "object", properties: {}, required: [] },
}

const boundedArrays = [
  ...["join_room", "create_room", "update_capabilities"].map((tool) => ({
    tool,
    field: "capabilities",
    args: (values: unknown[]) => ({ capabilities: values }),
  })),
  {
    tool: "send_text",
    field: "targetParticipantIds",
    args: (values: unknown[]) => ({
      text: "Hello",
      targetParticipantIds: values,
    }),
  },
  ...["send_collab_request", "send_collab_result"].map((tool) => ({
    tool,
    field: "attachmentIds",
    args: (values: unknown[]) => ({
      targetParticipantId: "other-agent",
      requestId: "request-1234",
      status: "completed",
      summary: "Hello",
      attachmentIds: values,
    }),
  })),
  {
    tool: "join_room",
    field: "runtimeHost.capabilities",
    args: (values: unknown[]) => ({
      runtimeHost: { ...runtimeHost, capabilities: values },
    }),
  },
  {
    tool: "update_runtime_host",
    field: "runtimeHost.capabilities.actions",
    args: (values: unknown[]) => ({
      runtimeHost: {
        ...runtimeHost,
        capabilities: [{ ...capability, actions: values }],
      },
    }),
  },
  {
    tool: "update_runtime_host",
    field: "runtimeHost.capabilities.actions.input.required",
    args: (values: unknown[]) => ({
      runtimeHost: {
        ...runtimeHost,
        capabilities: [
          {
            ...capability,
            actions: [
              { ...action, input: { ...action.input, required: values } },
            ],
          },
        ],
      },
    }),
  },
]

function harness() {
  const limit = vi.fn(async () => ({ success: true }))
  const kvGet = vi.fn(async () => null)
  const kvPut = vi.fn(async () => undefined)
  const idFromName = vi.fn((name: string) => name)
  const control = vi.fn(async () =>
    Response.json({ participant: { id: "agent" } })
  )
  const env = {
    MCP_JOIN_RATE_LIMITER: { limit },
    MCP_HANDLE_RATE_LIMITER: { limit },
    ROOMS_KV: { get: kvGet, put: kvPut },
    SFU_ROOM: { idFromName, get: () => ({ fetch: control }) },
  } as unknown as McpEnv
  const call = async (tool: string, args: Record<string, unknown>) => {
    const response = await handleMcpRequest(
      new Request("https://zchat.bfzone.ccwu.cc/mcp", {
        method: "POST",
        headers: {
          Origin: "https://zchat.bfzone.ccwu.cc",
          Host: "zchat.bfzone.ccwu.cc",
          "Content-Type": "application/json",
          Accept: "application/json",
          "Mcp-Method": "tools/call",
          "Mcp-Name": tool,
          "MCP-Protocol-Version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: tool,
            arguments: args,
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
    return (await response.json()) as {
      result?: { isError?: boolean; content: Array<{ text: string }> }
    }
  }
  return { call, limit, kvGet, kvPut, idFromName, control }
}

describe("MCP bounded collection validation (GHSA-mrhx-c7xc-m3w5)", () => {
  it.each(boundedArrays)(
    "$tool rejects oversized $field before parsing its invalid elements",
    async ({ tool, args }) => {
      const h = harness()
      // Small, local fixtures expose issue amplification without exhausting
      // memory. Both primitive and object elements must be skipped entirely.
      for (const invalid of [null, { unexpected: true }]) {
        const payload = await h.call(tool, {
          roomId: "validation-room",
          name: "Agent",
          participantHandle: "invalid-handle",
          ...args(Array(1024).fill(invalid)),
        })
        expect(payload.result?.isError).toBe(true)
        const message = payload.result?.content[0]?.text ?? ""
        expect(message).toContain("Too big: expected array")
        expect(message.includes("Invalid input")).toBe(false)
        expect(JSON.stringify(payload).length).toBeLessThan(2000)
      }
      for (const operation of [
        h.limit,
        h.kvGet,
        h.kvPut,
        h.idFromName,
        h.control,
      ])
        expect(operation).not.toHaveBeenCalled()
    }
  )

  it("preserves valid capability limits and rejects malformed in-bound elements", async () => {
    const h = harness()
    const args = { roomId: "validation-room", name: "Agent" }
    const accepted = await h.call("join_room", {
      ...args,
      capabilities: Array.from({ length: 8 }, (_, i) => `capability${i}`),
    })
    expect(accepted.result?.isError).not.toBe(true)
    expect(h.control).toHaveBeenCalledTimes(1)

    for (const capabilities of [Array(9).fill("valid"), [null]]) {
      const rejected = await h.call("join_room", { ...args, capabilities })
      expect(rejected.result?.isError).toBe(true)
    }
    expect(h.control).toHaveBeenCalledTimes(1)
    expect(h.limit).toHaveBeenCalledTimes(1)
  })
})
