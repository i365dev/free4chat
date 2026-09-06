import { useEffect, useRef } from "react"

type AudioVisualizerSize = "full" | "compact"

interface AudioVisualizerProps {
  audio?: MediaStream | null
  muteState: boolean
  size?: AudioVisualizerSize
}

const ORBIT_POINTS = 48
const TWO_PI = Math.PI * 2

/**
 * Draws a small, presentation-only audio orbit around a participant avatar.
 *
 * The analyser and animation loop stay entirely inside this component. The
 * parent card therefore does not re-render at audio-frame frequency, and no
 * room or media state is changed by the visualizer.
 */
export default function AudioVisualizer({
  audio,
  muteState,
  size = "full",
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hasAudioTrack = Boolean(audio && audio.getAudioTracks().length > 0)
  const canUseAudioContext =
    typeof window !== "undefined" && typeof window.AudioContext !== "undefined"

  useEffect(() => {
    const canvas = canvasRef.current
    if (
      !canvas ||
      !audio ||
      audio.getAudioTracks().length === 0 ||
      muteState ||
      typeof window === "undefined" ||
      typeof window.AudioContext === "undefined"
    ) {
      return
    }

    const context = new window.AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 256

    let source: MediaStreamAudioSourceNode
    try {
      source = context.createMediaStreamSource(audio)
      source.connect(analyser)
    } catch {
      void context.close().catch(() => undefined)
      return
    }

    const rect = canvas.getBoundingClientRect()
    const cssSize = Math.max(1, rect.width || (size === "compact" ? 52 : 82))
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(cssSize * pixelRatio)
    canvas.height = Math.round(cssSize * pixelRatio)

    const context2d = canvas.getContext("2d")
    if (!context2d) {
      source.disconnect()
      analyser.disconnect()
      void context.close().catch(() => undefined)
      return
    }
    context2d.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    const samples = new Uint8Array(analyser.fftSize)
    const pointEnvelope = new Float32Array(ORBIT_POINTS)
    const pointCoordinates = new Float32Array(ORBIT_POINTS * 2)
    const center = cssSize / 2
    const baseRadius = size === "compact" ? cssSize * 0.34 : cssSize * 0.43
    const maxDeformation = size === "compact" ? 3 : 9
    let smoothedLevel = 0
    let animationFrame = 0

    const draw = () => {
      analyser.getByteTimeDomainData(samples)

      let squareTotal = 0
      for (const sample of samples) {
        const centeredSample = (sample - 128) / 128
        squareTotal += centeredSample * centeredSample
      }
      const rms = Math.sqrt(squareTotal / samples.length)
      const targetLevel = Math.min(1, Math.max(0, (rms - 0.015) / 0.22))
      const smoothing = targetLevel > smoothedLevel ? 0.28 : 0.12
      smoothedLevel += (targetLevel - smoothedLevel) * smoothing

      context2d.clearRect(0, 0, cssSize, cssSize)
      const quiet = smoothedLevel < 0.02

      for (let point = 0; point < ORBIT_POINTS; point += 1) {
        const angle = (point / ORBIT_POINTS) * TWO_PI - Math.PI / 2
        const sampleIndex = Math.floor((point / ORBIT_POINTS) * samples.length)
        const centeredSample = (samples[sampleIndex] - 128) / 128
        const targetEnvelope = quiet
          ? 0
          : Math.min(1, Math.abs(centeredSample) * 4.2)
        const envelope = pointEnvelope[point]
        const envelopeSmoothing = targetEnvelope > envelope ? 0.22 : 0.1
        pointEnvelope[point] += (targetEnvelope - envelope) * envelopeSmoothing

        const staticContour =
          Math.sin(angle * 3) * 0.35 + Math.sin(angle * 5 + 0.7) * 0.18
        const deformation = quiet
          ? staticContour
          : pointEnvelope[point] * maxDeformation + smoothedLevel * 2.1
        const radius = baseRadius + deformation
        const x = center + Math.cos(angle) * radius
        const y = center + Math.sin(angle) * radius
        pointCoordinates[point * 2] = x
        pointCoordinates[point * 2 + 1] = y
      }

      const firstX = pointCoordinates[0]
      const firstY = pointCoordinates[1]
      const secondX = pointCoordinates[2]
      const secondY = pointCoordinates[3]
      context2d.beginPath()
      context2d.moveTo((firstX + secondX) / 2, (firstY + secondY) / 2)
      for (let point = 1; point <= ORBIT_POINTS; point += 1) {
        const currentIndex = (point % ORBIT_POINTS) * 2
        const nextIndex = ((point + 1) % ORBIT_POINTS) * 2
        const currentX = pointCoordinates[currentIndex]
        const currentY = pointCoordinates[currentIndex + 1]
        const nextMidX = (currentX + pointCoordinates[nextIndex]) / 2
        const nextMidY = (currentY + pointCoordinates[nextIndex + 1]) / 2
        context2d.quadraticCurveTo(currentX, currentY, nextMidX, nextMidY)
      }
      context2d.closePath()

      const gradient = context2d.createLinearGradient(0, 0, cssSize, cssSize)
      const opacity = 0.14 + smoothedLevel * 0.66
      gradient.addColorStop(0, `rgba(103, 232, 249, ${opacity})`)
      gradient.addColorStop(0.58, `rgba(129, 140, 248, ${opacity * 0.82})`)
      gradient.addColorStop(1, `rgba(192, 132, 252, ${opacity * 0.7})`)

      context2d.lineWidth = size === "compact" ? 0.9 : 1.25
      context2d.lineJoin = "round"
      context2d.lineCap = "round"
      context2d.strokeStyle = gradient
      context2d.shadowColor = `rgba(103, 232, 249, ${
        0.12 + smoothedLevel * 0.35
      })`
      context2d.shadowBlur = size === "compact" ? 3 : 4 + smoothedLevel * 9
      context2d.stroke()
      context2d.shadowBlur = 0

      animationFrame = requestAnimationFrame(draw)
    }

    const resume = () => {
      void context.resume().catch(() => undefined)
    }
    window.addEventListener("pointerdown", resume)
    window.addEventListener("keydown", resume)
    void context.resume().catch(() => undefined)
    draw()

    return () => {
      cancelAnimationFrame(animationFrame)
      window.removeEventListener("pointerdown", resume)
      window.removeEventListener("keydown", resume)
      source.disconnect()
      analyser.disconnect()
      void context.close().catch(() => undefined)
    }
  }, [audio, muteState, size])

  if (!hasAudioTrack || muteState || !canUseAudioContext) return null

  return (
    <canvas
      ref={canvasRef}
      className={`participant-audio-orbit participant-audio-orbit--${size}`}
      aria-hidden="true"
    />
  )
}
