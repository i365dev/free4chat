import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import AudioVisualizer from "./AudioVisualizer"

describe("AudioVisualizer", () => {
  it("does not render an empty frame without an audio track", () => {
    const { container } = render(
      <AudioVisualizer name="Hermes" muteState={false} />
    )

    expect(container.firstChild).toBeNull()
  })

  it("hides the ambient waveform while the participant is muted", () => {
    const stream = {
      getAudioTracks: () => [{}],
    } as unknown as MediaStream
    const { container } = render(
      <AudioVisualizer audio={stream} name="Hermes" muteState={true} />
    )

    expect(container.firstChild).toBeNull()
  })
})
