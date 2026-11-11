import type { CSSProperties } from "react"

const WARP_STREAKS = [
  { angle: -171, delay: -0.18, duration: 1.24, emerald: false },
  { angle: -149, delay: -0.82, duration: 1.52, emerald: false },
  { angle: -128, delay: -0.46, duration: 1.38, emerald: true },
  { angle: -108, delay: -1.14, duration: 1.68, emerald: false },
  { angle: -88, delay: -0.62, duration: 1.16, emerald: false },
  { angle: -69, delay: -1.31, duration: 1.48, emerald: false },
  { angle: -48, delay: -0.3, duration: 1.72, emerald: true },
  { angle: -29, delay: -0.95, duration: 1.32, emerald: false },
  { angle: -8, delay: -0.55, duration: 1.58, emerald: false },
  { angle: 13, delay: -1.04, duration: 1.2, emerald: false },
  { angle: 34, delay: -0.24, duration: 1.44, emerald: true },
  { angle: 53, delay: -1.47, duration: 1.76, emerald: false },
  { angle: 74, delay: -0.71, duration: 1.28, emerald: false },
  { angle: 94, delay: -1.2, duration: 1.62, emerald: false },
  { angle: 113, delay: -0.4, duration: 1.08, emerald: true },
  { angle: 133, delay: -1.36, duration: 1.4, emerald: false },
  { angle: 151, delay: -0.88, duration: 1.7, emerald: false },
  { angle: 172, delay: -0.12, duration: 1.34, emerald: false },
] as const

export default function RoomJoiningWarpScreen() {
  return (
    <div
      className="room-warp"
      data-testid="room-joining-warp"
      role="status"
      aria-live="polite"
    >
      <div className="room-warp__sky" aria-hidden="true" />
      <div className="room-warp__streaks" aria-hidden="true">
        {WARP_STREAKS.map((streak, index) => (
          <i
            className={`room-warp__streak${
              streak.emerald ? " room-warp__streak--emerald" : ""
            }`}
            key={index}
            style={
              {
                "--warp-angle": `${streak.angle}deg`,
                "--warp-delay": `${streak.delay}s`,
                "--warp-duration": `${streak.duration}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="room-warp__hud" aria-hidden="true">
        <span className="room-warp__ring room-warp__ring--outer" />
        <span className="room-warp__ring room-warp__ring--middle" />
        <span className="room-warp__loader" />
      </div>
      <div className="room-warp__copy">
        <p>Warping into room…</p>
        <p>Establishing room link</p>
      </div>
    </div>
  )
}
