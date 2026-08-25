import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import AgentWorkRequestComposer from "./AgentWorkRequestComposer"

const base = {
  agentName: "Agent B",
  capabilities: ["browser.control", "browser.authenticated"],
  maxLength: 1200,
}

describe("AgentWorkRequestComposer (#113)", () => {
  it("shows agent name, capability chips as metadata, and the explanatory copy", () => {
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByText(/Request work from Agent B/)).toBeTruthy()
    expect(screen.getByText("browser.control")).toBeTruthy()
    expect(
      screen.getByText(
        /The Agent may accept or decline\. This request does not grant new permissions\./
      )
    ).toBeTruthy()
  })

  it("disables Send for empty/whitespace summaries and enables with content", () => {
    const onSubmit = vi.fn()
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    )
    const send = screen.getByText("Send request") as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(
      screen.getByPlaceholderText("What would you like this Agent to do?"),
      {
        target: { value: "   " },
      }
    )
    expect(
      (screen.getByText("Send request") as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.change(
      screen.getByPlaceholderText("What would you like this Agent to do?"),
      {
        target: { value: "Verify the dashboard" },
      }
    )
    const enabled = screen.getByText("Send request") as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)
    expect(onSubmit).toHaveBeenCalledWith("Verify the dashboard")
  })

  it("bounds input to maxLength and reports length", () => {
    render(
      <AgentWorkRequestComposer
        {...base}
        maxLength={10}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    const field = screen.getByPlaceholderText(
      "What would you like this Agent to do?"
    ) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: "a".repeat(50) } })
    expect(field.value.length).toBe(10)
    expect(screen.getByText("10/10")).toBeTruthy()
  })

  it("Cancel invokes onCancel without submitting", () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    render(
      <AgentWorkRequestComposer
        {...base}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    )
    fireEvent.click(screen.getByText("Cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
