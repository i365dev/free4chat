import { act, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import AudioVisualizer from "./AudioVisualizer"

const streamWithTrack = () =>
  ({
    getAudioTracks: () => [{}],
  } as unknown as MediaStream)

describe("AudioVisualizer", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not render a signal without an audio track or while muted", () => {
    const noAudio = render(<AudioVisualizer muteState={false} />)
    expect(noAudio.container.firstChild).toBeNull()
    noAudio.unmount()

    const muted = render(
      <AudioVisualizer audio={streamWithTrack()} muteState={true} />
    )
    expect(muted.container.firstChild).toBeNull()
  })

  it("emits local radio pulses only while audio is above the speech threshold", () => {
    let amplitude = 0
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "AudioContext"
    )

    class FakeAudioContext {
      state = "running"

      createAnalyser() {
        return {
          fftSize: 256,
          getByteTimeDomainData: (samples: Uint8Array) => {
            samples.fill(128)
            if (amplitude > 0) samples[0] = 128 + amplitude
          },
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

      suspend() {
        return Promise.resolve()
      }

      close() {
        return Promise.resolve()
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext as unknown as typeof window.AudioContext,
    })
    vi.useFakeTimers()

    try {
      const { container } = render(
        <AudioVisualizer audio={streamWithTrack()} muteState={false} />
      )
      const signal = container.querySelector(".participant-audio-signal")
      expect(signal).toHaveAttribute("data-speaking", "false")

      amplitude = 110
      act(() => vi.advanceTimersByTime(440))
      expect(signal).toHaveAttribute("data-speaking", "true")

      amplitude = 0
      act(() => vi.advanceTimersByTime(255))
      expect(signal).toHaveAttribute("data-speaking", "false")
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "AudioContext", originalDescriptor)
      } else {
        Reflect.deleteProperty(window, "AudioContext")
      }
    }
  })

  it("shares one AudioContext across participant signals", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "AudioContext"
    )
    let contextsCreated = 0
    let contextsClosed = 0
    let resumes = 0

    class FakeAudioContext {
      state = "running"

      constructor() {
        contextsCreated += 1
      }

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
        resumes += 1
        return Promise.resolve()
      }

      suspend() {
        return Promise.resolve()
      }

      close() {
        contextsClosed += 1
        return Promise.resolve()
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext as unknown as typeof window.AudioContext,
    })

    try {
      const stream = streamWithTrack()
      const first = render(<AudioVisualizer audio={stream} muteState={false} />)
      const second = render(
        <AudioVisualizer audio={stream} muteState={false} />
      )

      expect(contextsCreated).toBe(1)
      expect(resumes).toBe(2)
      fireEvent.pointerDown(window)
      expect(resumes).toBe(4)
      first.unmount()
      expect(contextsClosed).toBe(0)
      fireEvent.keyDown(window)
      expect(resumes).toBe(5)
      second.unmount()
      expect(contextsClosed).toBe(1)
      fireEvent.pointerDown(window)
      expect(resumes).toBe(5)
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "AudioContext", originalDescriptor)
      } else {
        Reflect.deleteProperty(window, "AudioContext")
      }
    }
  })
})
