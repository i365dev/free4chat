import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"

import { participantAccent } from "./ParticipantAvatar"

interface Audio {
  audio?: MediaStream | null
  name: string
  muteState?: boolean | false
}

function getAudioContextConstructor() {
  if (typeof window === "undefined") return null
  return (
    window.AudioContext ??
    (
      window as Window & {
        webkitAudioContext?: typeof AudioContext
      }
    ).webkitAudioContext ??
    null
  )
}

/**
 * Read a local MediaStream's level for presentation only. The Room protocol
 * remains text/state based: no audio level leaves this browser.
 */
export function useAudioLevel(audio?: MediaStream | null, muted = false) {
  const [level, setLevel] = useState(0)
  const mutedRef = useRef(muted)

  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  useEffect(() => {
    const AudioContextConstructor = getAudioContextConstructor()
    if (
      !audio ||
      audio.getAudioTracks().length === 0 ||
      !AudioContextConstructor
    ) {
      setLevel(0)
      return
    }

    let audioContext: AudioContext
    let analyser: AnalyserNode
    let source: MediaStreamAudioSourceNode
    try {
      audioContext = new AudioContextConstructor()
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source = audioContext.createMediaStreamSource(audio)
    } catch {
      setLevel(0)
      return
    }

    const data = new Uint8Array(analyser.fftSize)
    let animationFrame = 0
    let smoothedLevel = 0

    source.connect(analyser)
    void audioContext.resume().catch(() => undefined)

    const sample = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (const value of data) {
        const normalized = (value - 128) / 128
        sum += normalized * normalized
      }
      const rms = Math.sqrt(sum / data.length)
      const target = mutedRef.current ? 0 : Math.min(1, rms * 3.2)
      smoothedLevel +=
        (target - smoothedLevel) * (target > smoothedLevel ? 0.35 : 0.14)
      setLevel(smoothedLevel < 0.015 ? 0 : smoothedLevel)
      animationFrame = requestAnimationFrame(sample)
    }

    sample()

    return () => {
      cancelAnimationFrame(animationFrame)
      source.disconnect()
      analyser.disconnect()
      void audioContext.close().catch(() => undefined)
    }
  }, [audio])

  return muted ? 0 : level
}

export default function AudioVisualizer({ audio, name, muteState }: Audio) {
  const level = useAudioLevel(audio, Boolean(muteState))
  const accent = participantAccent(name)
  const isSpeaking = level >= 0.08
  const isStrong = level >= 0.32

  return (
    <div
      className="participant-signal"
      data-audio-level={level.toFixed(2)}
      data-speaking={isSpeaking ? "true" : "false"}
      aria-label={isSpeaking ? "Speaking" : "Idle"}
      style={
        {
          "--participant-accent": accent,
          "--audio-level": level,
        } as CSSProperties
      }
    >
      <span
        className={`participant-signal__ring participant-signal__ring--outer ${
          isStrong ? "is-strong" : ""
        }`}
      />
      <span className="participant-signal__ring participant-signal__ring--inner" />
      <span className="participant-signal__dot" />
    </div>
  )
}
