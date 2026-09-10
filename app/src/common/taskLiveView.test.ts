import { describe, expect, it } from "vitest"

import {
  applyTaskLiveViewAction,
  reconcileTaskLiveViewState,
  validateTaskLiveViewSnapshot,
} from "./taskLiveView"

const snapshot = (revision = 1, count = 0) => ({
  taskRequestId: "task-1",
  surfaceId: "counter",
  authorityAgentId: "agent-a",
  revision,
  root: {
    type: "Card" as const,
    children: [
      { type: "Text" as const, text: "Local counter" },
      { type: "Value" as const, path: "count" },
      {
        type: "Button" as const,
        label: "+1",
        action: { type: "increment" as const, path: "count", amount: 1 },
      },
      {
        type: "Button" as const,
        label: "Reset",
        action: { type: "set" as const, path: "count", value: 0 },
      },
    ],
  },
  data: { count },
})

describe("Task Live View contract", () => {
  it("accepts the bounded counter surface and applies actions locally", () => {
    const result = validateTaskLiveViewSnapshot(snapshot())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    let data = result.snapshot.data
    data = applyTaskLiveViewAction(data, {
      type: "increment",
      path: "count",
      amount: 1,
    })
    data = applyTaskLiveViewAction(data, {
      type: "increment",
      path: "count",
      amount: 1,
    })
    expect(data.count).toBe(2)
    expect(
      applyTaskLiveViewAction(data, {
        type: "set",
        path: "count",
        value: 0,
      }).count
    ).toBe(0)
  })

  it("preserves compatible local values across a higher revision", () => {
    const first = validateTaskLiveViewSnapshot(snapshot())
    const second = validateTaskLiveViewSnapshot(snapshot(2, 0))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const local = reconcileTaskLiveViewState(undefined, first.snapshot)
    local.data = { count: 3 }
    const replaced = reconcileTaskLiveViewState(local, second.snapshot)
    expect(replaced).toMatchObject({ surfaceId: "counter", revision: 2 })
    expect(replaced.data.count).toBe(3)
  })

  it("fails closed for unknown components, markup, URLs, and oversized data", () => {
    expect(
      validateTaskLiveViewSnapshot({
        ...snapshot(),
        root: { type: "Html", html: "<b>x</b>" },
      })
    ).toMatchObject({ ok: false })
    expect(
      validateTaskLiveViewSnapshot({
        ...snapshot(),
        root: { type: "Text", text: "javascript:alert(1)" },
      })
    ).toMatchObject({ ok: false })
    expect(
      validateTaskLiveViewSnapshot({
        ...snapshot(),
        root: { type: "Text", text: "https://example.com" },
      })
    ).toMatchObject({ ok: false })
    expect(
      validateTaskLiveViewSnapshot({
        ...snapshot(),
        data: { count: 0, payload: "x".repeat(40_000) },
      })
    ).toMatchObject({ ok: false, error: "live_view_too_large" })
  })
})
