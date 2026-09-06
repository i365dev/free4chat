import type { CSSProperties } from "react"

import { PlanetAvatar } from "planet-avatar/react"

export type ParticipantAvatarSize = "compact" | "full"

export default function ParticipantAvatar({
  name,
  size = "full",
  className,
  speakingLevel = 0,
}: {
  name: string
  size?: ParticipantAvatarSize
  className?: string
  speakingLevel?: number
}) {
  const compact = size === "compact"
  const normalizedSpeakingLevel = Math.min(1, Math.max(0, speakingLevel))

  return (
    <span
      className={`participant-avatar ${
        compact ? "participant-avatar--compact" : ""
      } ${className ?? ""}`.trim()}
      data-speaking={normalizedSpeakingLevel > 0.02 ? "true" : "false"}
      style={
        {
          "--speaking-level": normalizedSpeakingLevel,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className="participant-avatar__ripple participant-avatar__ripple--one" />
      <span className="participant-avatar__ripple participant-avatar__ripple--two" />
      <PlanetAvatar
        className="participant-avatar__planet"
        seed={name}
        size={compact ? 36 : 56}
        variant="auto"
        rings={false}
        background="transparent"
      />
    </span>
  )
}
