import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

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

function inputView(taskRequestId: string) {
  return {
    taskRequestId,
    surfaceId: "form",
    authorityAgentId: "agent-a",
    revision: 1,
    root: {
      type: "Input" as const,
      path: "query",
      placeholder: "Filter",
    },
    data: { query: "initial" },
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

  it("reports a valid view once and reports meaningful button/input changes", () => {
    const stateStore: TaskLiveViewStateStore = { current: new Map() }
    const onVisible = vi.fn()
    const onInteract = vi.fn()
    const { rerender } = render(
      <TaskLiveView
        snapshot={view("task-1")}
        stateStore={stateStore}
        onVisible={onVisible}
        onInteract={onInteract}
      />
    )
    expect(onVisible).toHaveBeenCalledTimes(1)
    rerender(
      <TaskLiveView
        snapshot={view("task-1", 2)}
        stateStore={stateStore}
        onVisible={onVisible}
        onInteract={onInteract}
      />
    )
    expect(onVisible).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "+1" }))
    fireEvent.click(screen.getByRole("button", { name: "+1" }))
    expect(onInteract).toHaveBeenCalledTimes(2)

    const inputInteraction = vi.fn()
    rerender(
      <TaskLiveView
        snapshot={inputView("task-2")}
        stateStore={stateStore}
        onInteract={inputInteraction}
      />
    )
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "a" } })
    fireEvent.change(input, { target: { value: "ab" } })
    expect(inputInteraction).toHaveBeenCalledTimes(2)
  })
})
