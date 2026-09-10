import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import TaskLiveView from "./TaskLiveView"
import type { TaskLiveViewStateStore } from "../common/taskLiveView"

function view(taskRequestId: string, revision = 1, count = 0) {
  return {
    taskRequestId,
    surfaceId: "counter",
    authorityAgentId: "agent-a",
    revision,
    root: {
      type: "Column" as const,
      children: [
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
  }
}

describe("TaskLiveView", () => {
  it("handles the counter entirely in the browser without an action callback", () => {
    const stateStore: TaskLiveViewStateStore = { current: new Map() }
    render(<TaskLiveView snapshot={view("task-1")} stateStore={stateStore} />)
    const button = screen.getByRole("button", { name: "+1" })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getByTestId("live-view-value-count")).toHaveTextContent("3")
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    expect(screen.getByTestId("live-view-value-count")).toHaveTextContent("0")
  })

  it("keeps each Task's local state and retains compatible state after replacement", () => {
    const stateStore: TaskLiveViewStateStore = { current: new Map() }
    const { rerender } = render(
      <TaskLiveView snapshot={view("task-1")} stateStore={stateStore} />
    )
    fireEvent.click(screen.getByRole("button", { name: "+1" }))
    rerender(<TaskLiveView snapshot={view("task-2")} stateStore={stateStore} />)
    expect(screen.getByTestId("live-view-value-count")).toHaveTextContent("0")
    rerender(
      <TaskLiveView snapshot={view("task-1", 2, 0)} stateStore={stateStore} />
    )
    expect(screen.getByTestId("live-view-value-count")).toHaveTextContent("1")
    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    expect(screen.getByTestId("live-view-value-count")).toHaveTextContent("0")
  })
})
