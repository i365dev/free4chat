import assert from "node:assert/strict"
import { test } from "node:test"

import { ModernMcpFree4ChatClient } from "../src/free4chat/modernClient.js"
import { Free4ChatClientError } from "../src/free4chat/client.js"

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

test("joinRoom forwards capability advertisement and wait parses the roster projection", async () => {
  const originalFetch = globalThis.fetch
  const seenTools: Array<{ name?: string; args?: Record<string, unknown> }> = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    seenTools.push({ name: body.params?.name, args: body.params?.arguments })
    if (body.params?.name === "join_room")
      return mcpEnvelope({
        participant: { id: "agent-1" },
        participantHandle: "handle",
        cursor: 3,
        expiresAt: 123,
      })
    if (body.params?.name === "wait_for_events")
      return mcpEnvelope({
        events: [],
        cursor: 4,
        expiresAt: 124,
        participants: [
          {
            id: "agent-2",
            name: "Peer",
            kind: "agent",
            advertised: ["browser.authenticated"],
          },
        ],
      })
    return mcpEnvelope({})
  }

  try {
    const client = new ModernMcpFree4ChatClient("https://example.test/mcp")
    const join = await client.joinRoom("room", "Agent", ["code.edit", "github"])
    assert.equal(join.participantId, "agent-1")
    const joinCall = seenTools.find((tool) => tool.name === "join_room")
    assert.deepEqual(joinCall?.args, {
      roomId: "room",
      name: "Agent",
      capabilities: ["code.edit", "github"],
    })

    const wait = await client.waitForEvents("handle", 0, 0)
    assert.equal(wait.cursor, 4)
    assert.equal(
      wait.participants?.[0].advertised?.[0],
      "browser.authenticated"
    )
    assert.deepEqual(
      seenTools.find((tool) => tool.name === "wait_for_events")?.args,
      { participantHandle: "handle", cursor: 0, timeoutSeconds: 0 }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("collab tools forward boring explicit envelopes and surface server errors", async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ name?: string; args?: Record<string, unknown> }> = []
  const respond = (result: unknown) => mcpEnvelope(result)
  let mode = "happy"
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    calls.push({ name: body.params?.name, args: body.params?.arguments })
    if (mode === "error")
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "not_request_target" }),
            },
          ],
        },
      })
    if (body.params?.name === "send_collab_request")
      return respond({ requestId: "req-9", sequence: 21 })
    if (body.params?.name === "send_collab_response")
      return respond({ sequence: 22 })
    if (body.params?.name === "send_collab_result")
      return respond({ sequence: 23 })
    if (body.params?.name === "send_attachment")
      return respond({
        attachment: {
          id: "att-5",
          fileName: "shot.png",
          mimeType: "image/png",
          size: 3,
          sequence: 24,
        },
      })
    if (body.params?.name === "update_capabilities")
      return respond({ ok: true })
    return respond({})
  }

  try {
    const client = new ModernMcpFree4ChatClient("https://example.test/mcp")

    const request = await client.sendCollabRequest("handle", {
      targetParticipantId: "agent-b",
      summary: "Check the page",
      details: { url: "https://www.free4.chat" },
    })
    assert.deepEqual(request, { requestId: "req-9", sequence: 21 })

    await client.sendCollabResponse("handle", "req-9", "declined", "busy")
    await client.sendCollabResult("handle", {
      requestId: "req-9",
      status: "completed",
      summary: "done",
      attachmentIds: ["att-5"],
    })
    const upload = await client.uploadAttachment("handle", {
      fileName: "shot.png",
      mimeType: "image/png",
      dataBase64: "AAAA",
    })
    assert.equal(upload.id, "att-5")
    await client.updateCapabilities("handle", ["shell"])

    assert.deepEqual(
      calls.find((call) => call.name === "send_collab_request")?.args,
      {
        participantHandle: "handle",
        targetParticipantId: "agent-b",
        summary: "Check the page",
        details: { url: "https://www.free4.chat" },
      }
    )
    assert.deepEqual(
      calls.find((call) => call.name === "send_collab_response")?.args,
      {
        participantHandle: "handle",
        requestId: "req-9",
        decision: "declined",
        summary: "busy",
      }
    )
    assert.deepEqual(
      calls.find((call) => call.name === "send_collab_result")?.args,
      {
        participantHandle: "handle",
        requestId: "req-9",
        status: "completed",
        summary: "done",
        attachmentIds: ["att-5"],
      }
    )
    assert.deepEqual(
      calls.find((call) => call.name === "update_capabilities")?.args,
      { participantHandle: "handle", capabilities: ["shell"] }
    )

    mode = "error"
    await assert.rejects(
      () => client.sendCollabResponse("handle", "missing", "accepted"),
      (error: unknown) =>
        error instanceof Free4ChatClientError &&
        error.message.includes("not_request_target")
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("surface tools forward bounded envelopes and validate payloads strictly", async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ name?: string; args?: Record<string, unknown> }> = []
  let serveSurfacePublish: Record<string, unknown> = {
    surface: {
      kind: "workspace-snapshot",
      snapshotId: "snap-9",
      mimeType: "image/png",
      size: 4,
      updatedAt: 77,
    },
  }
  let serveRead: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    calls.push({ name: body.params?.name, args: body.params?.arguments })
    if (body.params?.name === "publish_surface") {
      if (serveSurfacePublish.__invalid)
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify(serveSurfacePublish) },
            ],
          },
        })
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            { type: "text", text: JSON.stringify(serveSurfacePublish) },
          ],
        },
      })
    }
    if (body.params?.name === "clear_surface")
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{}" }] },
      })
    if (body.params?.name === "read_surface") {
      if (!serveRead)
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "{}" }] },
        })
      return Response.json({ jsonrpc: "2.0", id: 1, result: serveRead })
    }
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "{}" }] },
    })
  }

  try {
    const client = new ModernMcpFree4ChatClient("https://example.test/mcp")

    const published = await client.publishSurface("handle", {
      mimeType: "image/png",
      dataBase64: "AAAA",
    })
    assert.equal(published.surface.snapshotId, "snap-9")
    assert.deepEqual(calls.find((c) => c.name === "publish_surface")?.args, {
      participantHandle: "handle",
      mimeType: "image/png",
      dataBase64: "AAAA",
    })

    await client.clearSurface("handle")
    assert.ok(calls.some((c) => c.name === "clear_surface"))

    serveRead = {
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
        {
          type: "text",
          text: JSON.stringify({
            surface: {
              kind: "workspace-snapshot",
              snapshotId: "snap-8",
              mimeType: "image/png",
              size: 3,
              updatedAt: 55,
            },
          }),
        },
      ],
    }
    const read = await client.readSurface("handle", "agent-b", "snap-8")
    assert.deepEqual(read.surface, {
      snapshotId: "snap-8",
      mimeType: "image/png",
      size: 3,
      updatedAt: 55,
    })
    assert.equal(read.data, "QUJD")

    // Malformed publish payload → typed client error.
    serveSurfacePublish = { __invalid: true, surface: { kind: "other" } }
    await assert.rejects(
      () =>
        client.publishSurface("handle", {
          mimeType: "image/png",
          dataBase64: "AA",
        }),
      (error: unknown) =>
        error instanceof Free4ChatClientError && error.code === "tool_error"
    )
    // Missing image content in read → typed client error.
    serveRead = { content: [{ type: "text", text: "{}" }] }
    await assert.rejects(
      () => client.readSurface("handle", "agent-b", "snap-8"),
      (error: unknown) =>
        error instanceof Free4ChatClientError && error.code === "tool_error"
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
