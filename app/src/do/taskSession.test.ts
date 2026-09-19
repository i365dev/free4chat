import { describe, expect, it } from "vitest"

import {
  agentSupportsTaskSessionContinuation,
  appendDedupedTaskSessions,
  boundedTaskSessionText,
  filterTaskSessions,
  hasOutstandingTaskSessionRequest,
  isTaskSessionError,
  isValidTaskSessionToken,
  sanitizeRuntimeFeatures,
  taskSessionErrorMessage,
  validateTaskSessionListResult,
  MAX_TASK_SESSION_PROJECTS,
  MAX_TASK_SESSION_ROWS,
  MAX_TASK_SESSION_TITLE_LENGTH,
  TASK_SESSION_PENDING_TTL_MS,
} from "./taskSession"

/**
 * #409 Task Session Continuation — Room-side bounds and sanitization.
 *
 * The Room is a RELAY here: it must be impossible for a malformed or hostile
 * Runtime projection to enable the feature, for a browser to receive a real
 * session identity, or for a truncated page to look complete.
 */

describe("sanitizeRuntimeFeatures (#409)", () => {
  it("accepts exactly the documented closed shape", () => {
    expect(sanitizeRuntimeFeatures({ taskSessionContinuation: true })).toEqual({
      taskSessionContinuation: true,
    })
  })

  it("drops everything else fail-closed", () => {
    for (const input of [
      undefined,
      null,
      "taskSessionContinuation",
      [],
      {},
      { taskSessionContinuation: false },
      { taskSessionContinuation: "true" },
      { taskSessionContinuation: 1 },
      { taskSessioncontinuation: true },
    ])
      expect(sanitizeRuntimeFeatures(input)).toBeUndefined()
  })

  it("drops unknown keys instead of persisting them", () => {
    // A whitelist, not a blacklist: a newer Runtime adding a feature this
    // build does not know about must never leak an unknown key into Room
    // participant state, and must not break the join either.
    expect(
      sanitizeRuntimeFeatures({
        taskSessionContinuation: true,
        futureFeature: true,
      })
    ).toEqual({ taskSessionContinuation: true })
  })

  it("gates the Continue affordance on the projection only", () => {
    expect(
      agentSupportsTaskSessionContinuation({
        kind: "agent",
        connected: true,
        runtimeFeatures: { taskSessionContinuation: true },
      })
    ).toBe(true)
    expect(
      agentSupportsTaskSessionContinuation({
        kind: "agent",
        connected: true,
      })
    ).toBe(false)
    expect(
      agentSupportsTaskSessionContinuation({
        kind: "agent",
        connected: false,
        runtimeFeatures: { taskSessionContinuation: true },
      })
    ).toBe(false)
    expect(
      agentSupportsTaskSessionContinuation({
        kind: "human",
        connected: true,
        runtimeFeatures: { taskSessionContinuation: true },
      })
    ).toBe(false)
  })
})

describe("boundedTaskSessionText (#409)", () => {
  it("folds control characters and bounds the length", () => {
    expect(boundedTaskSessionText("  hello\nworld  ", 64)).toBe("hello world")
    expect(boundedTaskSessionText("a".repeat(400), 32)).toHaveLength(32)
    expect(boundedTaskSessionText(undefined, 32)).toBe("")
    expect(boundedTaskSessionText(42, 32)).toBe("")
  })
})

describe("isValidTaskSessionToken (#409)", () => {
  it("bounds without repairing", () => {
    expect(isValidTaskSessionToken("abc")).toBe(true)
    expect(isValidTaskSessionToken(" abc")).toBe(false)
    expect(isValidTaskSessionToken("abc ")).toBe(false)
    expect(isValidTaskSessionToken("")).toBe(false)
    expect(isValidTaskSessionToken("t".repeat(65))).toBe(false)
    expect(isValidTaskSessionToken(undefined)).toBe(false)
  })
})

describe("validateTaskSessionListResult (#409)", () => {
  const row = {
    token: "session-token-1",
    title: "Fix shooter interpolation",
    projectToken: "project-token-1",
    projectLabel: "~/workspace/free4chat",
    updatedAt: "2026-09-19T10:00:00Z",
  }

  it("relays a bounded page and never exposes a real identity field", () => {
    const outcome = validateTaskSessionListResult({
      ok: true,
      sessions: [row],
      projects: [{ token: "project-token-1", label: "~/workspace/free4chat" }],
      nextPageToken: "page-token-1",
    })
    expect(outcome).toEqual({
      ok: true,
      sessions: [row],
      projects: [{ token: "project-token-1", label: "~/workspace/free4chat" }],
      nextPageToken: "page-token-1",
      hasMore: true,
    })
    // The relayed row has no field a real session id or cwd could travel in.
    expect(Object.keys(row).sort()).toEqual([
      "projectLabel",
      "projectToken",
      "title",
      "token",
      "updatedAt",
    ])
  })

  it("drops an unparseable updatedAt rather than rendering Invalid Date", () => {
    const outcome = validateTaskSessionListResult({
      ok: true,
      sessions: [{ ...row, updatedAt: 12345 }],
      projects: [],
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok !== true) return
    expect(outcome.sessions[0].updatedAt).toBeUndefined()
    expect(outcome.hasMore).toBe(false)
  })

  it("fails the WHOLE page closed when a row or bound is unusable", () => {
    expect(
      validateTaskSessionListResult({
        ok: true,
        sessions: [{ ...row, token: "" }],
        projects: [],
      })
    ).toEqual({ ok: false, error: "session_continuation_unavailable" })
    expect(
      validateTaskSessionListResult({
        ok: true,
        sessions: Array.from({ length: MAX_TASK_SESSION_ROWS + 1 }, () => row),
        projects: [],
      })
    ).toEqual({ ok: false, error: "session_continuation_unavailable" })
    expect(
      validateTaskSessionListResult({
        ok: true,
        sessions: [],
        projects: Array.from({ length: MAX_TASK_SESSION_PROJECTS + 1 }, () => ({
          token: "project-token-1",
          label: "~/x",
        })),
      })
    ).toEqual({ ok: false, error: "session_continuation_unavailable" })
    expect(
      validateTaskSessionListResult({ ok: true, sessions: [], projects: [] })
    ).toEqual({ ok: true, sessions: [], projects: [], hasMore: false })
    expect(validateTaskSessionListResult(null)).toEqual({
      ok: false,
      error: "session_continuation_unavailable",
    })
  })

  it("bounds untrusted titles instead of rejecting them", () => {
    const outcome = validateTaskSessionListResult({
      ok: true,
      sessions: [{ ...row, title: "t".repeat(1000) }],
      projects: [],
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok !== true) return
    expect(outcome.sessions[0].title).toHaveLength(
      MAX_TASK_SESSION_TITLE_LENGTH
    )
  })

  it("relays only the closed error set", () => {
    expect(
      validateTaskSessionListResult({
        ok: false,
        error: "session_selection_expired",
      })
    ).toEqual({ ok: false, error: "session_selection_expired" })
    expect(
      validateTaskSessionListResult({
        ok: false,
        error: "/private/tmp leaked path",
      })
    ).toEqual({ ok: false, error: "session_continuation_unavailable" })
    expect(isTaskSessionError("/private/tmp")).toBe(false)
    expect(isTaskSessionError("task_session_busy")).toBe(true)
  })
})

describe("taskSessionErrorMessage (#409)", () => {
  it("gives every bounded failure class actionable, secret-free text", () => {
    for (const code of [
      "session_continuation_unsupported",
      "invalid_session_control",
      "session_control_busy",
      "session_selection_expired",
      "session_continuation_unavailable",
      "task_session_busy",
      "task_agent_not_reachable",
      "task_session_not_pending",
    ] as const) {
      const message = taskSessionErrorMessage(code)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain("/private")
      expect(message).not.toContain("sessionId")
    }
    expect(taskSessionErrorMessage("session_selection_expired")).toMatch(
      /no longer available/i
    )
  })
})

describe("appendDedupedTaskSessions (#409)", () => {
  const row = (token: string) => ({
    token,
    title: token,
    projectToken: "project-token-1",
    projectLabel: "~/x",
  })

  it("appends only rows the Human does not already have", () => {
    expect(
      appendDedupedTaskSessions([row("a"), row("b")], [row("b"), row("c")])
    ).toEqual([row("a"), row("b"), row("c")])
  })
})

describe("filterTaskSessions (#409)", () => {
  const sessions = [
    {
      token: "a",
      title: "Fix shooter interpolation",
      projectToken: "p1",
      projectLabel: "~/workspace/free4chat",
    },
    {
      token: "b",
      title: "Analyze OHLC cache",
      projectToken: "p2",
      projectLabel: "~/workspace/myInvestPilot",
    },
  ]

  it("filters already-loaded rows by title and project label, case-insensitively", () => {
    expect(filterTaskSessions(sessions, "SHOOTER")).toHaveLength(1)
    expect(filterTaskSessions(sessions, "myinvestpilot")).toHaveLength(1)
    expect(filterTaskSessions(sessions, "  ")).toHaveLength(2)
    expect(filterTaskSessions(sessions, "nothing")).toHaveLength(0)
  })
})

describe("hasOutstandingTaskSessionRequest (#409)", () => {
  it("counts only live pending records", () => {
    const now = 1000
    expect(hasOutstandingTaskSessionRequest({}, now)).toBe(false)
    expect(
      hasOutstandingTaskSessionRequest(
        { pendingTaskSessionDiscovery: { requestId: "r", expiresAt: now + 1 } },
        now
      )
    ).toBe(true)
    expect(
      hasOutstandingTaskSessionRequest(
        { pendingTaskSessionDiscovery: { requestId: "r", expiresAt: now } },
        now
      )
    ).toBe(false)
    expect(
      hasOutstandingTaskSessionRequest(
        { pendingTaskSessionStart: { requestId: "r", expiresAt: now + 1 } },
        now
      )
    ).toBe(true)
  })

  it("keeps the bounded pending window short", () => {
    expect(TASK_SESSION_PENDING_TTL_MS).toBeLessThanOrEqual(30_000)
  })
})
