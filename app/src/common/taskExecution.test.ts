import { describe, expect, it } from "vitest"

import {
  isTaskExecutionPhase,
  isValidTaskExecutionShape,
  taskExecutionLabel,
} from "./taskExecution"

/**
 * #421 Task execution projection: the closed shape rule and the Human-facing
 * labels for the new QUEUED phase. A Task waiting behind a bounded execution
 * lane must be visibly waiting, never apparently hung.
 */

describe("Task execution projection shape (#421)", () => {
  it("accepts the closed set of phases", () => {
    expect(isTaskExecutionPhase("running")).toBe(true)
    expect(isTaskExecutionPhase("interrupting")).toBe(true)
    expect(isTaskExecutionPhase("queued")).toBe(true)
    expect(isTaskExecutionPhase("waiting")).toBe(false)
    expect(isTaskExecutionPhase(undefined)).toBe(false)
  })

  it("requires a current turn for running and interrupting", () => {
    expect(
      isValidTaskExecutionShape({
        currentTurnSequence: 7,
        phase: "running",
        queuedCount: 0,
      })
    ).toBe(true)
    expect(
      isValidTaskExecutionShape({
        currentTurnSequence: 7,
        phase: "interrupting",
        queuedCount: 2,
      })
    ).toBe(true)
    // A running claim without a turn is a claim about nothing.
    expect(
      isValidTaskExecutionShape({ phase: "running", queuedCount: 0 })
    ).toBe(false)
  })

  it("requires real waiting work for the queued phase", () => {
    expect(isValidTaskExecutionShape({ phase: "queued", queuedCount: 1 })).toBe(
      true
    )
    expect(isValidTaskExecutionShape({ phase: "queued", queuedCount: 0 })).toBe(
      false
    )
    // Queued with a current turn contradicts itself.
    expect(
      isValidTaskExecutionShape({
        currentTurnSequence: 7,
        phase: "queued",
        queuedCount: 1,
      })
    ).toBe(false)
    // No turn and no phase is a settled Task, which is valid.
    expect(isValidTaskExecutionShape({ queuedCount: 0 })).toBe(true)
  })
})

describe("Task execution labels (#421)", () => {
  it("presents a Task waiting for an execution lane as Queued, not hung", () => {
    const label = taskExecutionLabel({ phase: "queued", queuedCount: 2 })
    expect(label.label).toBe("Queued")
    expect(label.detail).toContain("waiting for an execution lane")
    expect(label.detail).toContain("2 queued")
  })

  it("keeps running-with-queued a single truthful state", () => {
    expect(
      taskExecutionLabel({
        currentTurnSequence: 9,
        phase: "running",
        queuedCount: 1,
      })
    ).toEqual({ label: "Running", detail: "1 queued" })
    expect(
      taskExecutionLabel({
        currentTurnSequence: 9,
        phase: "interrupting",
        queuedCount: 3,
      })
    ).toEqual({ label: "Interrupting", detail: "3 queued" })
  })

  it("still prefers a lost session over every other presentation", () => {
    expect(
      taskExecutionLabel({
        phase: "queued",
        queuedCount: 1,
        availability: "session_lost",
      })
    ).toEqual({ label: "Session lost" })
  })

  it("keeps the legacy depth-only projection rendering as before", () => {
    expect(taskExecutionLabel({ queuedCount: 2 })).toEqual({
      label: "Queued",
      detail: "2 queued",
    })
    expect(
      taskExecutionLabel({ queuedCount: 0, lastOutcome: "interrupted" })
    ).toEqual({ label: "Interrupted" })
    expect(taskExecutionLabel({ queuedCount: 0 })).toEqual({ label: "" })
  })
})
