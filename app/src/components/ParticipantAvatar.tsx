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
            cy="39"
            rx="31"
            ry="9"
            stroke="#fff"
            strokeOpacity=".48"
            strokeWidth="2.2"
            transform="rotate(-14 36 39)"
          />
          <path
            d="M16 40c10-5 22-5 38 1"
            stroke="#020617"
            strokeLinecap="round"
            strokeOpacity=".42"
            strokeWidth="3"
          />
          <circle cx="25" cy="26" r="3" fill="#fff" fillOpacity=".64" />
        </>
      )
    case "moon":
      return (
        <>
          <circle cx="36" cy="36" r="24" fill="#dbeafe" fillOpacity=".26" />
          <path
            d="M48 16c-8 4-13 12-13 21 0 10 6 18 15 22-4 2-9 3-14 1-14-4-22-18-18-32 3-11 13-19 25-19 2 0 4 0 5 1Z"
            fill={accent}
            fillOpacity=".82"
          />
          <circle cx="28" cy="29" r="4" fill="#020617" fillOpacity=".2" />
          <circle cx="43" cy="45" r="3" fill="#020617" fillOpacity=".24" />
          <circle cx="24" cy="45" r="2" fill="#fff" fillOpacity=".35" />
        </>
      )
    case "crystal":
      return (
        <>
          <path
            d="m36 10 17 15-6 30H25l-6-30 17-15Z"
            fill={gradient}
            stroke="#fff"
            strokeOpacity=".38"
            strokeWidth="1"
          />
          <path
            d="m36 10 2 45M19 25l19 11 15-11M25 55l13-19 9 19"
            stroke="#fff"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity=".34"
            strokeWidth="1"
          />
          <path d="m36 13 2 33-13-21 11-12Z" fill="#fff" fillOpacity=".3" />
        </>
      )
    case "energy-orb":
      return (
        <>
          <circle cx="36" cy="36" r="24" fill={gradient} />
          <circle
            cx="36"
            cy="36"
            r="14"
            stroke="#fff"
            strokeOpacity=".45"
            strokeWidth="1.3"
          />
          <circle cx="36" cy="36" r="4" fill="#fff" fillOpacity=".82" />
          <path
            d="M16 32c8-8 18-11 32-6M23 51c9 3 18 1 27-6"
            stroke="#fff"
            strokeLinecap="round"
            strokeOpacity=".3"
            strokeWidth="1.5"
          />
        </>
      )
    case "planet":
    default:
      return (
        <>
          <circle cx="36" cy="36" r="25" fill={gradient} />
          <path
            d="M12 42c11-7 25-8 42-2 3 1 6 3 8 5-7 11-19 17-32 15-9-1-15-7-18-18Z"
            fill="#020617"
            fillOpacity=".28"
          />
          <path
            d="M14 39c9-6 21-8 36-3 4 1 7 3 9 5"
            stroke="#fff"
            strokeLinecap="round"
            strokeOpacity=".34"
            strokeWidth="2"
          />
          <path
            d="M23 20c-3 6-3 13 0 20 3 7 9 12 17 14"
            stroke="#fff"
            strokeLinecap="round"
            strokeOpacity=".24"
            strokeWidth="1.5"
          />
          <circle cx="24" cy="25" r="3" fill="#fff" fillOpacity=".72" />
          <circle cx="50" cy="47" r="2" fill="#fff" fillOpacity=".45" />
        </>
      )
  }
}

function participantGlyph(kind: UserInfo["kind"]) {
  if (kind === "agent") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 2.5v2m-3.5 8h7M4.5 9.25a3.5 3.5 0 1 1 7 0v1.25h-7V9.25Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.3"
        />
        <circle cx="6.75" cy="8.7" r=".65" fill="currentColor" />
        <circle cx="9.25" cy="8.7" r=".65" fill="currentColor" />
      </svg>
    )
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <circle
        cx="8"
        cy="5.25"
        r="2.25"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M3.75 13.25c.45-2.05 1.83-3.1 4.25-3.1s3.8 1.05 4.25 3.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.3"
      />
    </svg>
  )
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
              <stop offset="0" stopColor="#fff" stopOpacity=".95" />
              <stop offset=".22" stopColor={accent} stopOpacity=".95" />
              <stop offset=".72" stopColor={accent} stopOpacity=".76" />
              <stop offset="1" stopColor={accent} stopOpacity=".3" />
            </radialGradient>
          </defs>
          {participantSurface(variant, accent, gradientId)}
        </svg>
      </div>
      <span className="participant-avatar__orbit participant-avatar__orbit--one" />
      <span className="participant-avatar__orbit participant-avatar__orbit--two" />
      <span
        className={`participant-avatar__status ${muted ? "is-muted" : ""}`}
        aria-hidden="true"
      />
      <span
        className="participant-avatar__kind"
        title={kind === "agent" ? "Agent" : "Human"}
      >
        {participantGlyph(kind)}
      </span>
    </div>
  )
}
