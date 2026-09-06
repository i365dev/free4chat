import { PlanetAvatar } from "planet-avatar/react"

export type ParticipantAvatarSize = "compact" | "full"

export default function ParticipantAvatar({
  name,
  size = "full",
  className,
}: {
  name: string
  size?: ParticipantAvatarSize
  className?: string
}) {
  const compact = size === "compact"

  return (
    <span
      className={`participant-avatar ${
        compact ? "participant-avatar--compact" : ""
      } ${className ?? ""}`.trim()}
      aria-hidden="true"
    >
      <PlanetAvatar
        seed={name}
        size={compact ? 36 : 56}
        variant="auto"
        rings="auto"
        background="transparent"
      />
    </span>
  )
}
