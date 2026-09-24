import { useEffect, useRef } from "react"

type AudioVisualizerSize = "full" | "compact"

interface AudioVisualizerProps {
  audio?: MediaStream | null
  muteState: boolean
  size?: AudioVisualizerSize
}

const SPEAKING_THRESHOLD = 0.018
const IDLE_SAMPLE_MS = 220
const SPEAKING_SAMPLE_MS = 85

let sharedAudioContext: AudioContext | null = null
let sharedAudioContextUsers = 0

function acquireAudioContext():
  | { context: AudioContext; release: () => void }
  | undefined {
  if (
    typeof window === "undefined" ||
    typeof window.AudioContext === "undefined"
  )
    return undefined

  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new window.AudioContext()
  }
  const context = sharedAudioContext
  sharedAudioContextUsers += 1
  let released = false

  return {
    context,
    release: () => {
      if (released) return
      released = true
      sharedAudioContextUsers = Math.max(0, sharedAudioContextUsers - 1)
      if (sharedAudioContextUsers === 0 && sharedAudioContext === context) {
        sharedAudioContext = null
        void context.close().catch(() => undefined)
      }
    },
  }
}

/**
 * Detects speech locally and emits two CSS radio pulses around a participant's
 * planet. One shared AudioContext serves the Room; silent streams are sampled
 * sparsely, while active voices get a short, low-rate sample cadence. No audio
 * or speaking state is sent to the Room or stored.
 */
export default function AudioVisualizer({
  audio,
  muteState,
  size = "full",
}: AudioVisualizerProps) {
  const signalRef = useRef<HTMLSpanElement>(null)
  const hasAudioTrack = Boolean(audio && audio.getAudioTracks().length > 0)

  useEffect(() => {
    const signal = signalRef.current
    if (
      !signal ||
      !audio ||
      audio.getAudioTracks().length === 0 ||
      muteState ||
      typeof window === "undefined" ||
      typeof window.AudioContext === "undefined"
    ) {
      return
    }

    const lease = acquireAudioContext()
    if (!lease) return
    const { context } = lease
    const analyser = context.createAnalyser()
    analyser.fftSize = 256

    let source: MediaStreamAudioSourceNode
    try {
      source = context.createMediaStreamSource(audio)
      source.connect(analyser)
    } catch {
      analyser.disconnect()
      lease.release()
      return
    }

    const samples = new Uint8Array(analyser.fftSize)
    let timer: number | undefined
    let speaking = false
    let aboveThresholdSamples = 0
    let belowThresholdSamples = 0
    let disposed = false

    const setSpeaking = (next: boolean) => {
      speaking = next
      signal.dataset.speaking = String(next)
    }

    const sample = () => {
      if (disposed) return
      if (document.visibilityState === "hidden") {
        setSpeaking(false)
        timer = window.setTimeout(sample, 1000)
        return
      }

      analyser.getByteTimeDomainData(samples)
      let squares = 0
      for (const value of samples) {
        const centered = (value - 128) / 128
        squares += centered * centered
      }
      const rms = Math.sqrt(squares / samples.length)

      if (rms >= SPEAKING_THRESHOLD) {
        aboveThresholdSamples += 1
        belowThresholdSamples = 0
        if (!speaking && aboveThresholdSamples >= 2) setSpeaking(true)
      } else {
        belowThresholdSamples += 1
        aboveThresholdSamples = 0
        if (speaking && belowThresholdSamples >= 3) setSpeaking(false)
      }

      timer = window.setTimeout(
        sample,
        speaking ? SPEAKING_SAMPLE_MS : IDLE_SAMPLE_MS
      )
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        setSpeaking(false)
        if (timer !== undefined) window.clearTimeout(timer)
        void context.suspend().catch(() => undefined)
        timer = window.setTimeout(sample, 1000)
        return
      }

      if (timer !== undefined) window.clearTimeout(timer)
      void context.resume().catch(() => undefined)
      timer = window.setTimeout(sample, 0)
    }

    // A browser may defer Web Audio until the next user gesture. Keep the
    // original retry path so voice presence starts after joining a Room.
    const resumeAfterGesture = () => {
      if (document.visibilityState !== "hidden")
        void context.resume().catch(() => undefined)
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("pointerdown", resumeAfterGesture)
    window.addEventListener("keydown", resumeAfterGesture)
    signal.dataset.speaking = "false"
    void context.resume().catch(() => undefined)
    sample()

    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("pointerdown", resumeAfterGesture)
      window.removeEventListener("keydown", resumeAfterGesture)
      setSpeaking(false)
      source.disconnect()
      analyser.disconnect()
      lease.release()
    }
  }, [audio, muteState])

  if (!hasAudioTrack || muteState) return null

  return (
    <span
      ref={signalRef}
      className={`participant-audio-signal participant-audio-signal--${size}`}
      data-speaking="false"
      aria-hidden="true"
    />
  )
}
