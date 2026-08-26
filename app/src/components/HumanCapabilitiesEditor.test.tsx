import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import HumanCapabilitiesEditor from "./HumanCapabilitiesEditor"

const base = {
  initialCapabilities: [] as string[],
  maxLength: 48,
  maxTokens: 8,
}

describe("HumanCapabilitiesEditor (#119)", () => {
  it("shows helper text stating capabilities do not grant permissions", () => {
    render(
      <HumanCapabilitiesEditor {...base} onSave={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(
      screen.getByText(
        /Capabilities help Agents discover what they may ask you to do\. They do not grant permissions\./,
      ),
    ).toBeTruthy()
  })

  it("adds a valid capability, removes one, and Save sends the FULL replacement list", () => {
    const onSave = vi.fn()
    render(
      <HumanCapabilitiesEditor
        {...base}
        initialCapabilities={["review.code"]}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    const input = screen.getByPlaceholderText("Add capability…")
    fireEvent.change(input, { target: { value: "judgment.product" } })
    fireEvent.click(screen.getByText("Add"))
    fireEvent.change(input, { target: { value: "design.ux" } })
    fireEvent.click(screen.getByText("Add"))
    // Remove review.code via its × button.
    fireEvent.click(screen.getByLabelText("Remove review.code"))
    fireEvent.click(screen.getByTestId("save-capabilities"))
    expect(onSave).toHaveBeenCalledWith(["judgment.product", "design.ux"])
  })

  it("prevents a ninth capability", () => {
    const initial = Array.from({ length: 8 }, (_, i) => `cap${i}`)
    render(
      <HumanCapabilitiesEditor
        {...base}
        initialCapabilities={initial}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const input = screen.getByPlaceholderText("Add capability…")
    fireEvent.change(input, { target: { value: "cap.extra" } })
    fireEvent.click(screen.getByText("Add"))
    expect(screen.getByText(/Max 8 capabilities\./)).toBeTruthy()
  })

  it("rejects invalid tokens and cannot save them into the list", () => {
    const onSave = vi.fn()
    render(
      <HumanCapabilitiesEditor {...base} onSave={onSave} onCancel={vi.fn()} />,
    )
    const input = screen.getByPlaceholderText("Add capability…")
    fireEvent.change(input, { target: { value: "Review Code!" } })
    fireEvent.click(screen.getByText("Add"))
    expect(screen.getByText(/Use lowercase namespaced tokens/)).toBeTruthy()
    // Nothing added → saving an empty list is allowed but sends [].
    fireEvent.click(screen.getByTestId("save-capabilities"))
    expect(onSave).toHaveBeenCalledWith([])
  })

  it("empty list may be saved (advertise nothing)", () => {
    const onSave = vi.fn()
    render(
      <HumanCapabilitiesEditor {...base} onSave={onSave} onCancel={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId("save-capabilities"))
    expect(onSave).toHaveBeenCalledWith([])
  })

  it("Cancel never calls onSave", () => {
    const onCancel = vi.fn()
    const onSave = vi.fn()
    render(
      <HumanCapabilitiesEditor
        {...base}
        initialCapabilities={["review.code"]}
        onSave={onSave}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByText("Cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })
})
