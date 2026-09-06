import { useId } from "react"
import type { CSSProperties } from "react"

import type { UserInfo } from "../common/types"

export type ParticipantAvatarSize = "compact" | "full"

// A small, fixed palette keeps the Room's accents legible while making the
// same participant/name render the same way on every client. The palette is
// intentionally shared by Humans and Agents; kind is shown by the badge, not
// by a separate avatar system.
const PARTICIPANT_ACCENTS = [
  "#67e8f9", // cyan
  "#c4b5fd", // violet
  "#fcd34d", // amber
  "#bef264", // lime
  "#f9a8d4", // rose
]

export type ParticipantAvatarVariant =
  | "planet"
  | "ringed-planet"
  | "moon"
  | "crystal"
  | "energy-orb"

const PARTICIPANT_AVATAR_VARIANTS: ParticipantAvatarVariant[] = [
  "planet",
  "ringed-planet",
  "moon",
  "crystal",
  "energy-orb",
]

function hashName(name: string) {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return hash
}

export function participantAccent(name: string) {
  return PARTICIPANT_ACCENTS[hashName(name) % PARTICIPANT_ACCENTS.length]
}

export function participantVariant(name: string) {
  return PARTICIPANT_AVATAR_VARIANTS[
    hashName(`${name}:avatar`) % PARTICIPANT_AVATAR_VARIANTS.length
  ]
}

function participantSurface(
  variant: ParticipantAvatarVariant,
  accent: string,
  gradientId: string
) {
  const gradient = `url(#${gradientId})`

  switch (variant) {
    case "ringed-planet":
      return (
        <>
          <circle cx="36" cy="36" r="24" fill={gradient} />
          <ellipse
            cx="36"
            cy="38"
            rx="30"
            ry="7"
            stroke="#fff"
            strokeOpacity=".58"
            strokeWidth="2"
            transform="rotate(-12 36 38)"
          />
          <circle cx="27" cy="27" r="3" fill="#fff" fillOpacity=".64" />
        </>
      )
    case "moon":
      return (
        <>
          <circle cx="36" cy="36" r="24" fill={gradient} />
          <path
            d="M48 14c-8 5-13 13-13 23 0 9 5 17 13 21-4 2-9 2-14 0-12-5-18-18-14-30 4-11 14-18 26-18h2Z"
            fill="#020617"
            fillOpacity=".52"
          />
          <circle cx="27" cy="28" r="2.5" fill="#fff" fillOpacity=".55" />
        </>
      )
    case "crystal":
      return (
        <>
          <path
            d="m36 11 15 15-5 29H26l-5-29 15-15Z"
            fill={gradient}
            stroke="#fff"
            strokeOpacity=".5"
            strokeWidth="1"
          />
          <path
            d="m36 12 1 42M21 26l16 10 14-10"
            stroke="#fff"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity=".38"
            strokeWidth="1"
          />
        </>
      )
    case "energy-orb":
      return (
        <>
          <circle cx="36" cy="36" r="24" fill={gradient} />
          <circle
            cx="36"
            cy="36"
            r="12"
            stroke="#fff"
            strokeOpacity=".5"
            strokeWidth="1.5"
          />
          <circle cx="36" cy="36" r="4" fill="#fff" fillOpacity=".82" />
        </>
      )
    case "planet":
    default:
      return (
        <>
          <circle cx="36" cy="36" r="25" fill={gradient} />
          <path
            d="M12 43c12-6 25-7 43-1 3 1 5 2 7 4-7 10-18 16-30 15-10-1-17-7-20-18Z"
            fill="#020617"
            fillOpacity=".28"
          />
          <path
            d="M15 39c11-5 23-6 37-2"
            stroke="#fff"
            strokeLinecap="round"
            strokeOpacity=".42"
            strokeWidth="1.8"
          />
          <circle cx="25" cy="25" r="3" fill="#fff" fillOpacity=".72" />
        </>
      )
  }
}

export default function ParticipantAvatar({
  name,
  kind,
  size = "full",
  muted = false,
  speaking = false,
  className,
}: {
  name: string
  kind: UserInfo["kind"]
  size?: ParticipantAvatarSize
  muted?: boolean
  speaking?: boolean
  className?: string
}) {
  const accent = participantAccent(name)
  const variant = participantVariant(name)
  const gradientId = `participant-avatar-${useId().replace(/:/g, "")}`
  const style = {
    "--participant-accent": accent,
  } as CSSProperties
  const sizeClass = size === "compact" ? "participant-avatar--compact" : ""

  return (
    <div
      data-testid="participant-avatar"
      data-avatar-variant={variant}
      data-participant-kind={kind}
      data-muted={muted ? "true" : "false"}
      className={`participant-avatar ${sizeClass} ${className ?? ""}`.trim()}
      style={style}
    >
      <div
        className={`participant-avatar__orb ${speaking ? "is-speaking" : ""}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 72 72" fill="none">
          <defs>
            <radialGradient id={gradientId} cx="30%" cy="25%">
              <stop offset="0" stopColor="#fff" stopOpacity=".8" />
              <stop offset=".3" stopColor={accent} stopOpacity=".95" />
              <stop offset="1" stopColor={accent} stopOpacity=".6" />
            </radialGradient>
          </defs>
          {participantSurface(variant, accent, gradientId)}
        </svg>
      </div>
    </div>
  )
}
