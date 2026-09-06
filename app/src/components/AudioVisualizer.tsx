import { useEffect } from "react"

interface Audio {
  audio?: MediaStream | null
  name: string
  muteState: boolean | false
  onLevel?: (level: number) => void
}

/**
 * Samples a participant track for presentation-only activity indicators.
 * The component intentionally renders no waveform DOM; UserCard consumes the
 * smoothed level to animate the avatar ripple instead.
 */
export default function AudioVisualizer(props: Audio) {
  const { audio, name, muteState, onLevel } = props
  useEffect(() => {
    if (!audio || audio.getAudioTracks().length === 0 || muteState) return
    const audioCtx = new AudioContext()
    void audioCtx.resume().catch(() => undefined)
    const analyser = audioCtx.createAnalyser()
    const audioSrc = audioCtx.createMediaStreamSource(audio)
    audioSrc.connect(analyser)
    analyser.fftSize = 256
    const levelArray = new Uint8Array(analyser.fftSize)

    let animationFrame = 0
    let lastLevelReport = 0
    let smoothedLevel = 0
    const draw = () => {
      animationFrame = requestAnimationFrame(draw)
      analyser.getByteTimeDomainData(levelArray)

      let squareTotal = 0
      for (const sample of levelArray) {
        const centeredSample = (sample - 128) / 128
        squareTotal += centeredSample * centeredSample
      }
      const rms = Math.sqrt(squareTotal / levelArray.length)
      const targetLevel = Math.min(1, Math.max(0, (rms - 0.015) / 0.22))
      const smoothing = targetLevel > smoothedLevel ? 0.28 : 0.12
      smoothedLevel += (targetLevel - smoothedLevel) * smoothing

      const now = performance.now()
      if (onLevel && now - lastLevelReport >= 80) {
        lastLevelReport = now
        onLevel(smoothedLevel)
      }
    }
    const resume = () => {
      void audioCtx.resume().catch(() => undefined)
    }
    window.addEventListener("pointerdown", resume)
    window.addEventListener("keydown", resume)
    draw()

    return () => {
      cancelAnimationFrame(animationFrame)
      window.removeEventListener("pointerdown", resume)
      window.removeEventListener("keydown", resume)
      onLevel?.(0)
      audioSrc.disconnect()
      analyser.disconnect()
      void audioCtx.close().catch(() => undefined)
    }
  }, [audio, name, muteState, onLevel])

  return null
}
