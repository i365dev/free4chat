import { describe, expect, it } from "vitest"

import {
  garbageCollectRuntimeHosts,
  normalizeRuntimeHosts,
  registerRuntimeHost,
  runtimeHostParticipantIds,
  updateRuntimeHost,
  validateRuntimeHost,
} from "./runtimeHost"

const HOST_A = {
  runtimeHostId: "11111111-2222-3333-4444-555555555555",
  speech: { stt: true, tts: true },
}

const HOST_B = {
  runtimeHostId: "99999999-8888-7777-6666-555555555555",
  speech: { stt: false, tts: false },
}

const agent = (id: string, runtimeHostId?: string) => ({
  id,
  kind: "agent" as const,
  ...(runtimeHostId ? { runtimeHostId } : {}),
})

describe("Runtime Host domain transitions", () => {
  it("validates only the bounded, secret-free projection", () => {
    expect(validateRuntimeHost(HOST_A)).toEqual({
      ok: true,
      runtimeHost: HOST_A,
    })
    expect(validateRuntimeHost({ ...HOST_A, runtimeHostId: "bad id" })).toEqual(
      {
        ok: false,
        error: "invalid_runtime_host",
        reason: "invalid_runtime_host_id",
      }
    )
    expect(
      validateRuntimeHost({ ...HOST_A, speech: { stt: true, tts: "yes" } })
    ).toEqual({
      ok: false,
      error: "invalid_runtime_host",
      reason: "invalid_speech",
    })
  })

  it("registers one shared projection for same-host Agents", () => {
    const once = registerRuntimeHost(undefined, HOST_A)
    const twice = registerRuntimeHost(once, HOST_A)
    expect(twice).toEqual({ [HOST_A.runtimeHostId]: HOST_A })
  })

  it("finds every Agent referencing one shared host", () => {
    const participants = [
      agent("pi", HOST_A.runtimeHostId),
      agent("hermes", HOST_A.runtimeHostId),
    ]
    expect(
      runtimeHostParticipantIds(participants, HOST_A.runtimeHostId)
    ).toEqual(["pi", "hermes"])
  })

  it("returns the previous projection for a hot update", () => {
    const participants = [
      agent("pi", HOST_A.runtimeHostId),
      agent("hermes", HOST_A.runtimeHostId),
    ]
    const transition = updateRuntimeHost(
      { [HOST_A.runtimeHostId]: HOST_A },
      participants,
      "pi",
      { ...HOST_A, speech: { stt: true, tts: false } }
    )
    expect(transition.previousProjection).toEqual(HOST_A)
    expect(transition.runtimeHosts[HOST_A.runtimeHostId].speech.tts).toBe(false)
  })

  it("can include a newly projected Agent in the shared-host references", () => {
    const transition = updateRuntimeHost(
      { [HOST_A.runtimeHostId]: HOST_A },
      [agent("pi")],
      "pi",
      { ...HOST_A, speech: { stt: true, tts: false } }
    )
    expect(
      runtimeHostParticipantIds([agent("pi")], HOST_A.runtimeHostId, "pi")
    ).toEqual(["pi"])
  })

  it("drops malformed hosts and dangling participant references on load", () => {
    const normalized = normalizeRuntimeHosts(
      {
        [HOST_A.runtimeHostId]: HOST_A,
        "bad id!": HOST_B,
      },
      [
        agent("pi", HOST_A.runtimeHostId),
        agent("ghost", HOST_B.runtimeHostId),
        agent("malformed", "bad id!"),
      ]
    )
    expect(normalized.runtimeHosts).toEqual({
      [HOST_A.runtimeHostId]: HOST_A,
    })
    expect(normalized.danglingParticipantIds).toEqual(["ghost", "malformed"])
    expect(normalized.changed).toBe(true)
  })

  it("garbage-collects only unreferenced hosts", () => {
    const hosts = {
      [HOST_A.runtimeHostId]: HOST_A,
      [HOST_B.runtimeHostId]: HOST_B,
    }
    expect(
      garbageCollectRuntimeHosts(hosts, [agent("pi", HOST_A.runtimeHostId)])
    ).toEqual({ [HOST_A.runtimeHostId]: HOST_A })
    expect(
      garbageCollectRuntimeHosts(hosts, [
        agent("pi", HOST_A.runtimeHostId),
        agent("hermes", HOST_B.runtimeHostId),
      ])
    ).toBe(hosts)
  })
})
