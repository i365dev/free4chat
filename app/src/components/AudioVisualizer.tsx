import { useEffect, useRef } from "react"

interface Audio {
  audio?: MediaStream | null
  name: string
  muteState: boolean | false
  onLevel?: (level: number) => void
}

export default function AudioVisualizer(props: Audio) {
  const analyserCanvas = useRef(null)
  const { audio, name, muteState, onLevel } = props
  useEffect(() => {
    if (!audio || audio.getAudioTracks().length === 0 || muteState) return
    const audioCtx = new AudioContext()
    void audioCtx.resume().catch(() => undefined)
    const analyser = audioCtx.createAnalyser()
    const audioSrc = audioCtx.createMediaStreamSource(audio)
    audioSrc.connect(analyser)
    analyser.fftSize = 256
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    analyser.getByteTimeDomainData(dataArray)

    const canvas = analyserCanvas.current
    const canvasCtx = canvas.getContext("2d")

    let animationFrame = 0
    let lastLevelReport = 0
    const draw = () => {
      const WIDTH = canvas.width
      const HEIGHT = canvas.height

      animationFrame = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      // clear canvas for next drawing
      canvasCtx.fillStyle = "rgba(2, 8, 20, 0.78)"
      canvasCtx.fillRect(0, 0, WIDTH, HEIGHT)

      const barWidth = 4
      let barHeight: number
      let x = 0
      let levelTotal = 0

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2
        levelTotal += dataArray[i]

        // const r = Math.floor(barHeight + 64)
        // if (g % 3 === 0) {
        //   canvasCtx.fillStyle = `rgb(${r},${g},${b})`
        // } else if (g % 3 === 1) {
        //   canvasCtx.fillStyle = `rgb(${g},${r},${b})`
        // } else {
        //   canvasCtx.fillStyle = `rgb(${g},${b},${r})`
        // }
        canvasCtx.fillStyle = "rgba(166, 243, 255, 0.92)"

        canvasCtx.fillRect(x, 40 - barHeight / 2, barWidth, barHeight)

        x += barWidth + 2
      }

      const now = performance.now()
      if (onLevel && now - lastLevelReport >= 80) {
        lastLevelReport = now
        onLevel(Math.min(1, levelTotal / bufferLength / 255))
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

  if (!audio || audio.getAudioTracks().length === 0 || muteState) return null

  return (
    <div className="visualizer room-visualizer mx-auto mt-4">
      <canvas
        ref={analyserCanvas}
        className="room-visualizer__canvas h-12 w-4/5"
      ></canvas>
    </div>
  )
}
