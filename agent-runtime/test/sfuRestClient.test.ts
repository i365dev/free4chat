import assert from "node:assert/strict"
import { test } from "node:test"

import { SfuRestClient } from "../src/media/sfuRestClient.js"

test("establishes the server-events transport with the official server-offer request shape", async () => {
  const originalFetch = globalThis.fetch
  let receivedBody: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({})
  }

  try {
    const client = new SfuRestClient("https://example.test", {
      room: "room",
      participantId: "participant",
      participantToken: "token",
    })
    await client.establishDataChannelTransport("session")

    assert.deepEqual(receivedBody, {
      room: "room",
      participantId: "participant",
      token: "token",
      sessionId: "session",
      dataChannel: {
        location: "remote",
        dataChannelName: "server-events",
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("serializes a class-like renegotiation answer as a plain SDP payload", async () => {
  const originalFetch = globalThis.fetch
  let receivedBody: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({})
  }

  try {
    const client = new SfuRestClient("https://example.test", {
      room: "room",
      participantId: "participant",
      participantToken: "token",
    })
    const answer = Object.create({ inherited: true }) as {
      type: string
      sdp: string
    }
    answer.type = "answer"
    answer.sdp = "v=0\r\n"

    await client.renegotiate("session", answer)

    assert.deepEqual(receivedBody?.sessionDescription, {
      type: "answer",
      sdp: "v=0\r\n",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("reports an SFU route and error code without echoing its response body", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json(
      {
        errorCode: "decoding_error",
        errorDescription: "untrusted upstream detail",
      },
      { status: 400 }
    )

  try {
    const client = new SfuRestClient("https://example.test", {
      room: "room",
      participantId: "participant",
      participantToken: "token",
    })

    await assert.rejects(
      client.establishDataChannelTransport("session"),
      /sfu_datachannels_establish_decoding_error/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
