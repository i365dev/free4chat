import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import HumanCollabResultComposer from "./HumanCollabResultComposer"

const base = {
  requestId: "req-res-9",
  maxLength: 1200,
}

describe("HumanCollabResultComposer (#121)", () => {
  it("renders Completed header and helper copy stating result does not grant tools or permissions", () => {
    render(
      <HumanCollabResultComposer
        {...base}
        status="completed"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByText(/Completed — request/)).toBeTruthy()
    expect(
      screen.getByText(
        /Your result is shared with the Agent\. It does not grant tools or permissions\./
      )
    ).toBeTruthy()
  })

  it("renders Failed header for failed status", () => {
    render(
      <HumanCollabResultComposer
        {...base}
        status="failed"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByText(/Failed — request/)).toBeTruthy()
  })

  it("disables Send for empty/whitespace notes", () => {
    const onSubmit = vi.fn()
    render(
      <HumanCollabResultComposer
        {...base}
        status="completed"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    )
    const send = screen.getByTestId(
      "send-collab-result-completed"
    ) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText("What was the outcome?"), {
      target: { value: "   " },
    })
    expect(
      (screen.getByTestId("send-collab-result-completed") as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it("trims the note and sends exact requestId/status/summary", () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    render(
      <HumanCollabResultComposer
        {...base}
        status="completed"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    )
    const field = screen.getByPlaceholderText("What was the outcome?")
    fireEvent.change(field, {
      target: { value: "  Reviewed. No blocking issue.  " },
    })
    fireEvent.click(screen.getByTestId("send-collab-result-completed"))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith("Reviewed. No blocking issue.")
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("enforces maximum length", () => {
    render(
      <HumanCollabResultComposer
        {...base}
        status="completed"
        maxLength={10}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    const field = screen.getByPlaceholderText(
      "What was the outcome?"
    ) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: "a".repeat(50) } })
    expect(field.value.length).toBe(10)
  })

  it("Cancel never submits", () => {
    const onCancel = vi.fn()
    const onSubmit = vi.fn()
    render(
      <HumanCollabResultComposer
        {...base}
        status="failed"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    )
    fireEvent.click(screen.getByText("Cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("exposes no attachment or details inputs", () => {
    render(
      <HumanCollabResultComposer
        {...base}
        status="completed"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.queryByText(/attachment/i)).toBeNull()
    expect(screen.queryByLabelText(/details/i)).toBeNull()
    expect(screen.queryAllByRole("textbox").length).toBe(1)
  })
})
