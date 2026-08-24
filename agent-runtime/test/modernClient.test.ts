import assert from "node:assert/strict"
import { test } from "node:test"

import { ModernMcpFree4ChatClient } from "../src/free4chat/modernClient.js"

function mcpEnvelope(result: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
    },
  })
}

test("readAttachment decodes text-like attachments from the JSON envelope", async () => {
  const originalFetch = globalThis.fetch
  const fileText =
    "# \u672c\u5730\u6d4b\u8bd5\u8bae\u7a0b\n\n- \u7b2c\u4e00\u9879：\u9a8c\u8bc1\u6587\u672c\u9644\u4ef6\n"
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    assert.equal(body.params?.name, "read_attachment")
    assert.equal(body.params.arguments?.attachmentId, "att-1")
    return mcpEnvelope({
      attachment: { id: "att-1", mimeType: "text/markdown", fileName: "a.md" },
      data: Buffer.from(fileText, "utf8").toString("base64"),
      text: fileText,
    })
  }

  try {
    const client = new ModernMcpFree4ChatClient("https://example.test/mcp")
    const result = await client.readAttachment("handle", "att-1")
    assert.equal(result.mimeType, "text/markdown")
    assert.equal(result.text, fileText)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("readAttachment still returns image payloads unchanged", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "image",
            data: "AAAA",
            mimeType: "image/png",
          },
        ],
      },
    })

  try {
    const client = new ModernMcpFree4ChatClient("https://example.test/mcp")
    const result = await client.readAttachment("handle", "att-2")
    assert.equal(result.data, "AAAA")
    assert.equal(result.mimeType, "image/png")
    assert.equal(result.text, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("enrichTurnAttachments inlines bounded text files and caps content", async () => {
  const { enrichTurnAttachments } = await import("../src/core/runtime.js")
  const longText = "x".repeat(40_000)
  const events: HarnessEvent[] = [
    {
      sender: "A",
      kind: "human",
      addressed: true,
      sequence: 1,
      createdAt: 1,
      attachment: {
        id: "t1",
        fileName: "a.md",
        mimeType: "text/markdown",
        size: 10,
      },
    },
    {
      sender: "B",
      kind: "human",
      addressed: true,
      sequence: 2,
      createdAt: 2,
      attachment: {
        id: "img",
        fileName: "p.png",
        mimeType: "image/png",
        size: 10,
      },
    },
    {
      sender: "C",
      kind: "human",
      addressed: true,
      sequence: 3,
      createdAt: 3,
      attachment: {
        id: "gone",
        fileName: "lost.bin",
        mimeType: "application/zip",
        size: 10,
      },
    },
  ]
  const unavailable: string[] = []
  await enrichTurnAttachments(
    { room: { ephemeral: true }, events },
    "handle",
    async (id) => {
      if (id === "t1")
        return { data: "", mimeType: "text/markdown", text: longText }
      if (id === "img") return { data: "AAAA", mimeType: "image/png" }
      throw new Error("attachment_unavailable")
    },
    (_e, msg) => unavailable.push(msg)
  )
  assert.equal(events[0].textFile?.content.length, 32_000)
  assert.equal(events[0].textFile?.fileName, "a.md")
  assert.equal(events[1].image?.data, "AAAA")
  assert.equal(events[1].textFile, undefined)
  assert.equal(unavailable.length, 1)
})

test("readAttachment surfaces lifecycle codes from isError tool results", async () => {
  const originalFetch = globalThis.fetch
  const cases: Array<{ serverError: string; expectedCode: string }> = [
    {
      serverError: "invalid_participant_handle",
      expectedCode: "invalid_participant_handle",
    },
    { serverError: "room_expired", expectedCode: "room_expired" },
    { serverError: "attachment_unavailable", expectedCode: "tool_error" },
  ]
  try {
    for (const c of cases) {
      globalThis.fetch = async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify({ error: c.serverError }) },
            ],
          },
        })
      const client = new ModernMcpFree4ChatClient("https://example.test/mcp")
      let caught: unknown
      try {
        await client.readAttachment("handle", "att-1")
      } catch (e) {
        caught = e
      }
      assert.ok(caught instanceof Error)
      assert.equal((caught as { code?: string }).code, c.expectedCode)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("buildSpeechNotice: accurate wording, never solicits keys in room", async () => {
  const { buildSpeechNotice } = await import("../src/core/runtime.js")
  const noProvider = buildSpeechNotice({
    providerId: null,
    hasProvider: false,
    valuesComplete: false,
  })
  assert.match(noProvider ?? "", /no speech-to-text provider/)
  assert.match(noProvider ?? "", /don't paste API keys into this room/)
  assert.doesNotMatch(noProvider ?? "", /paste.*key.*here|reply with/i)

  const missingKey = buildSpeechNotice({
    providerId: "doubao",
    hasProvider: true,
    valuesComplete: false,
  })
  assert.match(missingKey ?? "", /missing its API key/)
  assert.match(missingKey ?? "", /my own session/)

  assert.equal(
    buildSpeechNotice({
      providerId: "doubao",
      hasProvider: true,
      valuesComplete: true,
    }),
    null
  )
})
