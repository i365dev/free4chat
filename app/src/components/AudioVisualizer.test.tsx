import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import AudioVisualizer from "./AudioVisualizer"

describe("AudioVisualizer", () => {
  it("renders an idle signal without a MediaStream", () => {
    const { container, getByLabelText } = render(
      <AudioVisualizer name="Hermes" />
    )
    const signal = getByLabelText("Idle")
    expect(signal).toHaveAttribute("data-speaking", "false")
    expect(signal).toHaveAttribute("data-audio-level", "0.00")
    expect(container.querySelector("canvas")).toBeNull()
  })

  it("renders the same local signal grammar for muted participants", () => {
    const { getByLabelText } = render(
      <AudioVisualizer name="Pi" muteState audio={null} />
    )
    expect(getByLabelText("Idle")).toHaveAttribute("data-audio-level", "0.00")
  })
})
