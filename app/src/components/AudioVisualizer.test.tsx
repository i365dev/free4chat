import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import AudioVisualizer from "./AudioVisualizer"

describe("AudioVisualizer", () => {
  it("does not render an empty frame without an audio track", () => {
    const { container } = render(<AudioVisualizer muteState={false} />)

    expect(container.firstChild).toBeNull()
  })

  it("hides the ambient waveform while the participant is muted", () => {
    const stream = {
      getAudioTracks: () => [{}],
    } as unknown as MediaStream
    const { container } = render(
      <AudioVisualizer audio={stream} muteState={true} />
    )

    expect(container.firstChild).toBeNull()
  })

  it("renders an avatar-sized orbit only for an active track", () => {
    const originalAudioContext = window.AudioContext
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    class FakeAudioContext {
      createAnalyser() {
        return {
          fftSize: 256,
          getByteTimeDomainData: (samples: Uint8Array) => samples.fill(128),
          disconnect: () => undefined,
        } as unknown as AnalyserNode
      }

      createMediaStreamSource() {
        return {
          connect: () => undefined,
          disconnect: () => undefined,
        } as unknown as MediaStreamAudioSourceNode
      }

      resume() {
        return Promise.resolve()
      }

      close() {
        return Promise.resolve()
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    })
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    })

    const stream = {
      getAudioTracks: () => [{}],
    } as unknown as MediaStream
    try {
      const { container } = render(
        <AudioVisualizer audio={stream} muteState={false} size="full" />
      )

      expect(container.querySelector("canvas")).toHaveClass(
        "participant-audio-orbit--full"
      )
    } finally {
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: originalAudioContext,
      })
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: originalGetContext,
      })
    }
  })
})
