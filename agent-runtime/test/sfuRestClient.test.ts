import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SfuRestClient,
  type SfuSignalPurpose,
} from "../src/media/sfuRestClient.js"

function handle() {
  return {
    room: "room",
    participantId: "participant",
    participantToken: "token",
  }
}

function captureBody(): {
  body: Record<string, unknown> | undefined
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    // Generic-envelope response that satisfies every signaling method's
    // response parsing (subscribe/publish need an SDP description).
    return Response.json({
      active: true,
      sessionDescription: { type: "answer", sdp: "v=0\r\n" },
      tracks: [],
    })
  }
  return {
    get body() {
      return body
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test("establishes the server-events transport with the official server-offer request shape", async () => {
  const capture = captureBody()

  try {
    const client = new SfuRestClient("https://example.test", handle())
    await client.establishDataChannelTransport(
      "session",
      undefined,
      "agent-transport"
    )

    assert.deepEqual(capture.body, {
      room: "room",
      participantId: "participant",
      token: "token",
      sessionId: "session",
      purpose: "agent-transport",
      dataChannel: {
        location: "remote",
        dataChannelName: "server-events",
      },
    })
  } finally {
    capture.restore()
  }
})

test("serializes a class-like renegotiation answer as a plain SDP payload", async () => {
  const capture = captureBody()

  try {
    const client = new SfuRestClient("https://example.test", handle())
    const answer = Object.create({ inherited: true }) as {
      type: string
      sdp: string
    }
    answer.type = "answer"
    answer.sdp = "v=0\r\n"

    await client.renegotiate("session", answer, "meeting-notes")

    assert.deepEqual(capture.body?.sessionDescription, {
      type: "answer",
      sdp: "v=0\r\n",
    })
    assert.equal(capture.body?.purpose, "meeting-notes")
  } finally {
    capture.restore()
  }
})

test("every signaling method carries its typed purpose on the wire (#83 review)", async () => {
  const cases: Array<{
    purpose: SfuSignalPurpose
    call: (client: SfuRestClient) => Promise<unknown>
  }> = [
    {
      purpose: "agent-transport",
      call: (client) =>
        client.establishDataChannelTransport("s", undefined, "agent-transport"),
    },
    {
      purpose: "meeting-notes",
      call: (client) =>
        client.subscribeTrack("s", "human-sess", "mic", "meeting-notes"),
    },
    {
      purpose: "meeting-notes",
      call: (client) =>
        client.renegotiate(
          "s",
          { type: "answer", sdp: "v=0\r\n" },
          "meeting-notes"
        ),
    },
    {
      purpose: "voice-reply",
      call: (client) =>
        client.renegotiate(
          "s",
          { type: "answer", sdp: "v=0\r\n" },
          "voice-reply"
        ),
    },
    {
      purpose: "voice-reply",
      call: (client) =>
        client.publishAudioTrack!("s", {
          trackName: "agent-voice",
          mid: "mid-1",
          offer: { type: "offer", sdp: "v=0\r\n" },
        }),
    },
  ]

  for (const testCase of cases) {
    const capture = captureBody()
    try {
      const client = new SfuRestClient("https://example.test", handle())
      await testCase.call(client)
      assert.equal(
        capture.body?.purpose,
        testCase.purpose,
        `purpose must be threaded for ${testCase.purpose}`
      )
    } finally {
      capture.restore()
    }
  }
})

test("confirms the published PCM track through the Agent-only endpoint", async () => {
  const capture = captureBody()
  try {
    const client = new SfuRestClient("https://example.test", handle())
    await assert.doesNotReject(async () => {
      assert.equal(
        await client.confirmPublishedAudioTrackActive!("s", "agent-voice"),
        true
      )
    })
    assert.deepEqual(capture.body, {
      room: "room",
      participantId: "participant",
      token: "token",
      sessionId: "s",
      trackName: "agent-voice",
    })
  } finally {
    capture.restore()
  }
})

test("treats an inactive publication confirmation as false", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ active: false })
  try {
    const client = new SfuRestClient("https://example.test", handle())
    assert.equal(
      await client.confirmPublishedAudioTrackActive!("s", "agent-voice"),
      false
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("subscribeTrack keeps the remote-track payload shape and carries the mid back", async () => {
  const originalFetch = globalThis.fetch
  let receivedBody: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      sessionDescription: { type: "offer", sdp: "v=0\r\n" },
      tracks: [{ mid: "mid-9" }],
    })
  }

  try {
    const client = new SfuRestClient("https://example.test", handle())
    const offer = await client.subscribeTrack(
      "session",
      "human-session",
      "mic-name",
      "meeting-notes"
    )

    assert.deepEqual(receivedBody?.tracks, [
      { location: "remote", sessionId: "human-session", trackName: "mic-name" },
    ])
    assert.equal(receivedBody?.purpose, "meeting-notes")
    assert.equal(offer.mid, "mid-9")
  } finally {
    globalThis.fetch = originalFetch
  }
})
