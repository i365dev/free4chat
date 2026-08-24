import { describe, expect, it } from "vitest"

import {
  agentCapabilitiesFrom,
  CollabRegistry,
  MAX_ADVERTISED_CAPABILITIES,
  rosterProjection,
  sanitizeStoredAgentCapabilities,
  validateAdvertisedCapabilities,
  validateCollabEvent,
  type CollabValidationContext,
} from "./collab"
import type { AgentCapabilities, RoomParticipant } from "../room/types"

function participant(
  overrides: Partial<RoomParticipant> = {}
): RoomParticipant {
  return {
    id: "agent-a",
    name: "Agent A",
    kind: "agent",
    connected: true,
    joinedAt: 1000,
    lastSeenAt: 1000,
    token: "token-a",
    capabilities: { text: true },
    ...overrides,
  }
}

function collabContext(
  overrides: Partial<CollabValidationContext> = {}
): CollabValidationContext {
  return {
    senderParticipantId: "agent-a",
    participants: {
      "agent-a": participant(),
      "agent-b": participant({ id: "agent-b", name: "Agent B", token: "t-b" }),
      "human-1": participant({
        id: "human-1",
        kind: "human",
        name: "Human",
        token: "t-h",
        media: {
          sessionId: "s1",
          muted: false,
          fileChannelReady: false,
          tracks: [],
        },
      }),
    },
    attachments: [{ id: "att-1" }],
    ...overrides,
  }
}

describe("validateAdvertisedCapabilities", () => {
  it("accepts a small honest namespaced set", () => {
    const result = validateAdvertisedCapabilities([
      "code.edit",
      "github",
      "browser.authenticated",
    ])
    expect(result).toEqual({
      ok: true,
      capabilities: ["code.edit", "github", "browser.authenticated"],
    })
  })

  it("normalizes case and surrounding whitespace and dedupes", () => {
    const result = validateAdvertisedCapabilities([
      " Code.Edit ",
      "code.edit",
      "SHELL",
    ])
    expect(result).toEqual({
      ok: true,
      capabilities: ["code.edit", "shell"],
    })
  })

  it("accepts an empty list (text-only agent)", () => {
    expect(validateAdvertisedCapabilities([])).toEqual({
      ok: true,
      capabilities: [],
    })
  })

  it("rejects non-array input and non-string entries", () => {
    expect(validateAdvertisedCapabilities("code.edit").ok).toBe(false)
    expect(validateAdvertisedCapabilities([42]).ok).toBe(false)
  })

  it("rejects more than the bounded maximum", () => {
    const tooMany = Array.from(
      { length: MAX_ADVERTISED_CAPABILITIES + 1 },
      (_, i) => `cap${i}`
    )
    const result = validateAdvertisedCapabilities(tooMany)
    expect(result.ok).toBe(false)
    if (result.ok === false) expect(result.reason).toContain("too_many")
  })

  it("rejects oversized entries", () => {
    expect(validateAdvertisedCapabilities(["a".repeat(49)]).ok).toBe(false)
  })

  it("rejects values that are not namespaced tokens", () => {
    for (const bad of [
      "has space",
      "two..dots",
      ".leading",
      "trailing.",
      "",
      "*",
    ])
      expect(validateAdvertisedCapabilities([bad]).ok).toBe(false)
  })
})

describe("agentCapabilitiesFrom", () => {
  it("keeps the historical text-only shape when nothing is advertised", () => {
    expect(agentCapabilitiesFrom([])).toEqual({ text: true })
  })

  it("carries advertised tokens alongside text", () => {
    expect(agentCapabilitiesFrom(["shell"])).toEqual({
      text: true,
      advertised: ["shell"],
    })
  })
})

describe("sanitizeStoredAgentCapabilities", () => {
  it("repairs a missing capabilities record to text-only", () => {
    const { capabilities, changed } = sanitizeStoredAgentCapabilities(undefined)
    expect(capabilities).toEqual({ text: true })
    expect(changed).toBe(true)
  })

  it("keeps clean records untouched (same reference)", () => {
    const clean: AgentCapabilities = { text: true, advertised: ["shell"] }
    const { capabilities, changed } = sanitizeStoredAgentCapabilities(clean)
    expect(changed).toBe(false)
    expect(capabilities).toBe(clean)
  })

  it("drops invalid/oversized stored entries without rejecting the room", () => {
    const dirty: AgentCapabilities = {
      text: true,
      advertised: ["ok.token", "bad token", `${"x".repeat(60)}`, "ok.token"],
    }
    const { capabilities, changed } = sanitizeStoredAgentCapabilities(dirty)
    expect(changed).toBe(true)
    expect(capabilities.advertised).toEqual(["ok.token"])
  })
})

describe("rosterProjection", () => {
  it("lists connected participants with agent capability metadata only", () => {
    const roster = rosterProjection({
      "agent-a": participant(),
      "agent-off": participant({ id: "agent-off", connected: false }),
      "human-1": participant({
        id: "human-1",
        name: "Human",
        kind: "human",
      }),
    })
    expect(roster).toEqual([
      {
        id: "agent-a",
        name: "Agent A",
        kind: "agent",
      },
      { id: "human-1", name: "Human", kind: "human" },
    ])
  })

  it("exposes advertised tokens so peers can answer who-can-do-X", () => {
    const roster = rosterProjection({
      "agent-b": participant({
        id: "agent-b",
        name: "Agent B",
        capabilities: { text: true, advertised: ["browser.authenticated"] },
      }),
    })
    expect(roster[0].advertised).toEqual(["browser.authenticated"])
  })
})

describe("validateCollabEvent", () => {
  it("validates a targeted request with summary, details, and attachment refs", () => {
    const result = validateCollabEvent(
      {
        kind: "request",
        requestId: "req-1",
        targetParticipantId: "agent-b",
        summary: "Validate the deployed page",
        details: { url: "https://www.free4.chat" },
        attachmentIds: ["att-1"],
      },
      collabContext()
    )
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.event).toEqual({
        requestId: "req-1",
        kind: "request",
        fromParticipantId: "agent-a",
        targetParticipantId: "agent-b",
        summary: "Validate the deployed page",
        details: { url: "https://www.free4.chat" },
        attachmentIds: ["att-1"],
      })
  })

  it("rejects requests whose target is absent, disconnected, or self", () => {
    const base = {
      kind: "request",
      requestId: "req-1",
      summary: "hi",
    }
    expect(
      validateCollabEvent(
        { ...base, targetParticipantId: "ghost" },
        collabContext()
      ).ok
    ).toBe(false)
    expect(
      validateCollabEvent(
        { ...base, targetParticipantId: "agent-off" },
        collabContext({
          participants: {
            "agent-a": participant(),
            "agent-off": participant({ id: "agent-off", connected: false }),
          },
        })
      ).ok
    ).toBe(false)
    expect(
      validateCollabEvent(
        { ...base, targetParticipantId: "agent-a" },
        collabContext()
      ).ok
    ).toBe(false)
  })

  it("requires a request summary and rejects unbounded details/refs", () => {
    const context = collabContext()
    expect(
      validateCollabEvent(
        { kind: "request", requestId: "req-1", targetParticipantId: "agent-b" },
        context
      ).ok
    ).toBe(false)
    expect(
      validateCollabEvent(
        {
          kind: "request",
          requestId: "req-1",
          targetParticipantId: "agent-b",
          summary: "s",
          details: Object.fromEntries(
            Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])
          ),
        },
        context
      ).ok
    ).toBe(false)
    expect(
      validateCollabEvent(
        {
          kind: "request",
          requestId: "req-1",
          targetParticipantId: "agent-b",
          summary: "s",
          attachmentIds: ["missing"],
        },
        context
      ).ok
    ).toBe(false)
  })

  it("enforces boring explicit requestId shapes", () => {
    for (const bad of ["", "abc", "has space", `${"a".repeat(65)}`])
      expect(
        validateCollabEvent(
          {
            kind: "request",
            requestId: bad,
            targetParticipantId: "agent-b",
            summary: "s",
          },
          collabContext()
        ).ok
      ).toBe(false)
  })

  it("shape-checks response/result kinds without requiring routing fields", () => {
    for (const kind of ["accepted", "declined"] as const)
      expect(
        validateCollabEvent(
          { kind, requestId: "req-1", summary: "on it" },
          collabContext()
        ).ok
      ).toBe(true)
    const failed = validateCollabEvent(
      { kind: "failed", requestId: "req-1", summary: "no browser here" },
      collabContext()
    )
    expect(failed.ok).toBe(true)
  })

  it("rejects unknown kinds entirely", () => {
    expect(
      validateCollabEvent(
        { kind: "delegated", requestId: "req-1" },
        collabContext()
      ).ok
    ).toBe(false)
  })
})

describe("CollabRegistry", () => {
  const requestEvent = {
    requestId: "req-1",
    kind: "request" as const,
    fromParticipantId: "agent-a",
    targetParticipantId: "agent-b",
    summary: "do a thing",
  }

  it("records a request once and collapses retried sends to the original sequence", () => {
    const registry = new CollabRegistry()
    expect(registry.recordRequest(requestEvent, 7)).toEqual({
      action: "recorded",
      sequence: 7,
    })
    expect(registry.recordRequest(requestEvent, 8)).toEqual({
      action: "duplicate",
      sequence: 7,
    })
  })

  it("lets only the request target respond and correlates routing from the record", () => {
    const registry = new CollabRegistry()
    registry.recordRequest(requestEvent, 7)
    expect(registry.routingFor("req-1", "agent-c")).toBeNull()
    expect(registry.routingFor("req-1", "agent-b")).toEqual({
      fromParticipantId: "agent-b",
      targetParticipantId: "agent-a",
    })
    expect(
      registry.recordResponse(
        { ...requestEvent, kind: "accepted", summary: undefined },
        "agent-a",
        9
      )
    ).toEqual({ action: "rejected", error: "not_request_target" })
    expect(
      registry.recordResponse(
        { ...requestEvent, kind: "accepted" },
        "agent-b",
        9
      )
    ).toEqual({ action: "recorded", sequence: 9 })
  })

  it("rejects responses for unknown requests", () => {
    const registry = new CollabRegistry()
    expect(
      registry.recordResponse(
        { ...requestEvent, kind: "completed", summary: "done" },
        "agent-b",
        3
      )
    ).toEqual({ action: "rejected", error: "unknown_request" })
  })

  it("makes repeated identical lifecycle steps idempotent while allowing later steps", () => {
    const registry = new CollabRegistry()
    registry.recordRequest(requestEvent, 7)
    registry.recordResponse({ ...requestEvent, kind: "accepted" }, "agent-b", 9)
    expect(
      registry.recordResponse(
        { ...requestEvent, kind: "accepted" },
        "agent-b",
        10
      )
    ).toEqual({ action: "duplicate", sequence: 9 })
    expect(
      registry.recordResponse(
        { ...requestEvent, kind: "completed", summary: "done" },
        "agent-b",
        11
      )
    ).toEqual({ action: "recorded", sequence: 11 })
  })

  it("stays bounded by evicting oldest requests first-in-first-out", () => {
    const registry = new CollabRegistry(2)
    registry.recordRequest({ ...requestEvent, requestId: "r1" }, 1)
    registry.recordRequest({ ...requestEvent, requestId: "r2" }, 2)
    registry.recordRequest({ ...requestEvent, requestId: "r3" }, 3)
    expect(registry.find("r1")).toBeUndefined()
    expect(registry.find("r2")).toBeDefined()
    expect(registry.size).toBe(2)
  })
})
