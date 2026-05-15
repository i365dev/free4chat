import { useEffect, useRef } from "react"

import { nameToColor, strToRGB } from "../common/utils"

interface Audio {
  audio: MediaStream
  name: string
  muteState: boolean | false
}

export default function AudioVisualizer(props: Audio) {
  const analyserCanvas = useRef(null)
  useEffect(() => {
    const color = nameToColor(props.name)
    if (props.audio === undefined) return
    const audioCtx = new AudioContext()
    const analyser = audioCtx.createAnalyser()
    const audioSrc = audioCtx.createMediaStreamSource(props.audio)
    audioSrc.connect(analyser)
    analyser.fftSize = 256
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    analyser.getByteTimeDomainData(dataArray)

    const canvas = analyserCanvas.current
    const canvasCtx = canvas.getContext("2d")

    const g = color[1]
    const b = color[2]

    const draw = () => {
      const WIDTH = canvas.width
      const HEIGHT = canvas.height

      requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      // clear canvas for next drawing
      canvasCtx.fillStyle = strToRGB(props.name)
      canvasCtx.fillRect(0, 0, WIDTH, HEIGHT)

      const barWidth = 4
      let barHeight: number
      let x = 0

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2

        // const r = Math.floor(barHeight + 64)
        // if (g % 3 === 0) {
        //   canvasCtx.fillStyle = `rgb(${r},${g},${b})`
        // } else if (g % 3 === 1) {
        //   canvasCtx.fillStyle = `rgb(${g},${r},${b})`
        // } else {
        //   canvasCtx.fillStyle = `rgb(${g},${b},${r})`
        // }
        canvasCtx.fillStyle = `rgb(255,255,255)`

        canvasCtx.fillRect(x, 40 - barHeight / 2, barWidth, barHeight)

        x += barWidth + 2
      }
    }
    draw()
  }, [props.audio, props.name])

  return (
    <div className="visualizer mx-auto mt-4">
      <canvas ref={analyserCanvas} className="h-12 w-4/5"></canvas>
    </div>
  )
}
