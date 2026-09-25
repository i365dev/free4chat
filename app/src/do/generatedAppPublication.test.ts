import { describe, expect, it, vi } from "vitest"

import { RoomSession } from "./RoomSession"
import type { RoomRecord } from "../room/types"

const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000

function makeRoom(): RoomRecord {
  return {
    createdAt: 1,
    analyticsRoomId: crypto.randomUUID(),
    expiresAt: FAR_FUTURE,
    participants: {
      "human-1": {
        id: "human-1",
        name: "Human",
        kind: "human",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "human-token",
        media: {
          sessionId: "human-session",
          muted: false,
          fileChannelReady: true,
          tracks: [],
        },
      },
      "agent-a": {
        id: "agent-a",
        name: "Agent",
        kind: "agent",
        connected: true,
        joinedAt: 1,
        lastSeenAt: Date.now(),
        token: "agent-token",
        connectionNonce: "agent-nonce",
      },
    },
    messages: [],
    nextMessageSequence: 0,
    attachments: [],
    nextTranscriptSequence: 0,
    nextLiveTranscriptEpoch: 1,
    liveTranscript: { active: false },
    liveTranscriptSegments: [],
    meetingNotes: { active: false },
    agentVoice: {},
    pendingMediaCleanup: [],
  }
}

function bundle(title: string, marker: string) {
  return {
    version: 1,
    manifest: { title, networkOrigins: [] },
    html: `<main>${marker}</main>`,
    css: "main { font: 16px sans-serif; }",
    js: `document.body.dataset.marker = ${JSON.stringify(marker)}`,
    initialState: { items: [] },
  }
}

function harness() {
  const store = new Map<string, unknown>([["room", makeRoom()]])
  const storagePut = vi.fn(async (key: string, value: unknown) => {
    store.set(key, value)
  })
  const humanSocket = { send: vi.fn() } as unknown as WebSocket
  const ctx = {
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: storagePut,
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
      },
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
      getAlarm: async () => undefined,
    },
    getWebSockets: () => [humanSocket],
  }
  const session = new RoomSession(ctx as never, { SFU_ROOM: {} } as never)
  const sendHuman = async (message: unknown) =>
    await (
      session as unknown as {
        handleClientMessage: (
          socket: WebSocket,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      humanSocket,
      {
        participantId: "human-1",
        token: "human-token",
        connectionNonce: "human-connection",
      },
      message
    )
  const sendGeneratedState = async (
    appInstanceId: string,
    expectedRevision: number,
    state: Record<string, unknown>
  ) =>
    await (
      session as unknown as {
        handleClientMessage: (
          socket: WebSocket,
          attachment: unknown,
          message: unknown
        ) => Promise<void>
      }
    ).handleClientMessage(
      humanSocket,
      {
        participantId: "human-1",
        token: "human-token",
        connectionNonce: "human-connection",
      },
      {
        type: "generated-app-state-update",
        appInstanceId,
        expectedRevision,
        state,
      }
    )
  const publish = async (taskRequestId: string, value: unknown) => {
    const response = await session.fetch(
      new Request("https://room/control", {
        method: "POST",
        body: JSON.stringify({
          action: "agent-publish-generated-app",
          participantId: "agent-a",
          token: "agent-token",
          taskRequestId,
          bundle: value,
        }),
      })
    )
    return {
      status: response.status,
      json: (await response.json()) as Record<string, any>,
    }
  }
  const stored = () => store.get("room") as RoomRecord
  return {
    sendHuman,
    sendGeneratedState,
    publish,
    stored,
    session,
    storagePut,
    humanSocket,
  }
}

describe("RoomSession generated Task App publication", () => {
  it("keeps one Task identity across idempotent retries and bundle updates", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Create a shared checklist for this Task",
    })
    const taskRequestId = test.stored().messages[0]?.collab?.requestId
    expect(taskRequestId).toBeTruthy()
    if (!taskRequestId) return
    const analytics = vi.spyOn(
      test.session as unknown as {
        trackRoomAnalytics: (events: unknown[]) => void
      },
      "trackRoomAnalytics"
    )

    const first = await test.publish(
      taskRequestId,
      bundle("Checklist", "first")
    )
    expect(first.status).toBe(200)
    expect(first.json.duplicate).toBe(false)
    const firstPublication = first.json.publication
    expect(firstPublication).toMatchObject({
      taskRequestId,
      bundleRevision: 1,
      stateRevision: 0,
    })

    const retry = await test.publish(
      taskRequestId,
      bundle("Checklist", "first")
    )
    expect(retry.status).toBe(200)
    expect(retry.json.duplicate).toBe(true)
    expect(retry.json.publication).toEqual(firstPublication)
    expect(analytics).toHaveBeenCalledTimes(1)

    const update = await test.publish(
      taskRequestId,
      bundle("Updated checklist", "second")
    )
    expect(update.status).toBe(200)
    expect(update.json).toMatchObject({ duplicate: false, updated: true })
    expect(update.json.publication).toMatchObject({
      appInstanceId: firstPublication.appInstanceId,
      taskRequestId,
      bundleRevision: 2,
      stateRevision: 0,
      createdAt: firstPublication.createdAt,
      title: "Updated checklist",
    })
    expect(test.stored().generatedApps).toEqual({
      [firstPublication.appInstanceId]: update.json.publication,
    })
    expect(analytics).toHaveBeenCalledTimes(2)
    expect(
      analytics.mock.calls.map(([events]) => (events as any[])[0])
    ).toEqual([
      expect.objectContaining({
        name: "RoomAppPublished",
        properties: expect.objectContaining({
          appSource: "generated",
          phase: "first",
        }),
      }),
      expect.objectContaining({
        name: "RoomAppPublished",
        properties: expect.objectContaining({
          appSource: "generated",
          phase: "update",
        }),
      }),
    ])

    const read = await test.session.fetch(
      new Request(
        `https://room/generated-app?appInstanceId=${encodeURIComponent(
          firstPublication.appInstanceId
        )}`,
        {
          headers: {
            "X-Room-Participant-Id": "human-1",
            "X-Room-Participant-Token": "human-token",
          },
        }
      )
    )
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      publication: update.json.publication,
      bundle: bundle("Updated checklist", "second"),
      state: { items: [] },
    })
  })

  it("bounds generated state writes by count, bytes, and window", async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      const test = harness()
      await test.sendHuman({
        type: "collab-request",
        targetParticipantId: "agent-a",
        summary: "Create a shared checklist",
      })
      const taskRequestId = test.stored().messages[0]?.collab?.requestId
      if (!taskRequestId) throw new Error("missing task request")
      const publication = (
        await test.publish(taskRequestId, bundle("Checklist", "rate"))
      ).json.publication

      for (let revision = 0; revision < 40; revision += 1)
        await test.sendGeneratedState(publication.appInstanceId, revision, {
          items: [{ text: `item-${revision}` }],
        })
      const writesBeforeReject = test.storagePut.mock.calls.length
      await test.sendGeneratedState(publication.appInstanceId, 40, {
        items: [{ text: "rejected" }],
      })
      expect(
        test.stored().generatedApps?.[publication.appInstanceId]
      ).toMatchObject({
        stateRevision: 40,
      })
      expect(test.storagePut).toHaveBeenCalledTimes(writesBeforeReject)
      expect(test.humanSocket.send).toHaveBeenCalledWith(
        expect.stringContaining('"generated_app_state_rate_limited"')
      )

      vi.setSystemTime(Date.now() + 10_001)
      await test.sendGeneratedState(publication.appInstanceId, 40, {
        items: [{ text: "after-window" }],
      })
      expect(
        test.stored().generatedApps?.[publication.appInstanceId]
      ).toMatchObject({
        stateRevision: 41,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects byte-heavy generated state before another storage write", async () => {
    const test = harness()
    await test.sendHuman({
      type: "collab-request",
      targetParticipantId: "agent-a",
      summary: "Create a shared checklist",
    })
    const taskRequestId = test.stored().messages[0]?.collab?.requestId
    if (!taskRequestId) throw new Error("missing task request")
    const publication = (
      await test.publish(taskRequestId, bundle("Checklist", "bytes"))
    ).json.publication
    for (let revision = 0; revision < 20; revision += 1)
      await test.sendGeneratedState(publication.appInstanceId, revision, {
        blob: "x".repeat(3_000),
      })
    const writesBeforeReject = test.storagePut.mock.calls.length
    await test.sendGeneratedState(publication.appInstanceId, 20, {
      blob: "y".repeat(3_000),
    })
    expect(
      test.stored().generatedApps?.[publication.appInstanceId]
    ).toMatchObject({
      stateRevision: 20,
    })
    expect(test.storagePut).toHaveBeenCalledTimes(writesBeforeReject)
    expect(test.humanSocket.send).toHaveBeenCalledWith(
      expect.stringContaining('"generated_app_state_rate_limited"')
    )
  })
})
