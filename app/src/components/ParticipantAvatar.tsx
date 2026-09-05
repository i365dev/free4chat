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
}: {
  name: string
  kind: UserInfo["kind"]
  size?: ParticipantAvatarSize
  muted?: boolean
  speaking?: boolean
}) {
  const accent = participantAccent(name)
  const style = {
    "--participant-accent": accent,
  } as CSSProperties
  const sizeClass = size === "compact" ? "participant-avatar--compact" : ""

  return (
    <div
      data-testid="participant-avatar"
      className={`participant-avatar ${sizeClass}`}
      style={style}
    >
      <div
        className={`participant-avatar__orb ${speaking ? "is-speaking" : ""}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 72 72" fill="none">
          <defs>
            <radialGradient id={`orb-${hashName(name)}`} cx="30%" cy="25%">
              <stop offset="0" stopColor="#fff" stopOpacity=".95" />
              <stop offset=".22" stopColor={accent} stopOpacity=".95" />
              <stop offset="1" stopColor={accent} stopOpacity=".16" />
            </radialGradient>
          </defs>
          <circle cx="36" cy="36" r="25" fill={`url(#orb-${hashName(name)})`} />
          <path
            d="M14 39c9-6 21-8 36-3 4 1 7 3 9 5"
            stroke="#fff"
            strokeLinecap="round"
            strokeOpacity=".28"
            strokeWidth="2"
          />
          <path
            d="M23 20c-3 6-3 13 0 20 3 7 9 12 17 14"
            stroke="#fff"
            strokeLinecap="round"
            strokeOpacity=".22"
            strokeWidth="1.5"
          />
          <circle cx="24" cy="25" r="3" fill="#fff" fillOpacity=".72" />
          <circle cx="50" cy="47" r="2" fill="#fff" fillOpacity=".45" />
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
