import { useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"

import { LOCAL_PEER_ID } from "@common/consts"

import AudioVisualizer from "./AudioVisualizer"
import ParticipantAvatar, { participantAccent } from "./ParticipantAvatar"
import type { UserInfo } from "../common/types"

interface UserCardProps extends UserInfo {
  onMuteSelf?: () => void
  onToggleScreenShare?: () => void
  screenshareAllowed?: boolean
  compact?: boolean
  /** Room-wide publish authorization for this eligible Agent only. */
  voiceAvailable?: boolean
  voiceEnabled?: boolean
  onToggleAgentVoice?: () => void
}

function MicIcon({ muted = false }: { muted?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      {muted ? (
        <>
          <path d="M13 8c0 .564-.094 1.107-.266 1.613l-.814-.814A4.02 4.02 0 0 0 12 8V7a.5.5 0 0 1 1 0v1Zm-5 4c.818 0 1.578-.245 2.212-.667l.718.719a4.973 4.973 0 0 1-2.43.923V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 1 0v1a4 4 0 0 0 4 4Zm3-9v4.879l-1-1V3a2 2 0 0 0-3.997-.118l-.845-.845A3.001 3.001 0 0 1 11 3Z" />
          <path d="m9.486 10.607-.748-.748A2 2 0 0 1 6 8v-.878l-1-1V8a3 3 0 0 0 4.486 2.607ZM1.646 1.354l12 12-.708.708-12-12 .708-.708Z" />
        </>
      ) : (
        <>
          <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5Z" />
          <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5ZM8 0a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V3a3 3 0 0 0-3-3Z" />
        </>
      )}
    </svg>
  )
}

function ScreenIcon({ active = false }: { active?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
      {active ? (
        <path d="M0 4s0-2 2-2h12s2 0 2 2v6s0 2-2 2h-4c0 .667.083 1.167.25 1.5H11a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h.75c.167-.333.25-.833.25-1.5H2s-2 0-2-2V4Zm1.398-.855a.758.758 0 0 0-.254.302A1.46 1.46 0 0 0 1 4.01V10c0 .325.078.502.145.602.07.105.17.188.302.254a1.464 1.464 0 0 0 .538.143L2.01 11H14c.325 0 .502-.078.602-.145a.758.758 0 0 0 .254-.302 1.464 1.464 0 0 0 .143-.538L15 9.99V4c0-.325-.078-.502-.145-.602a.757.757 0 0 0-.302-.254A1.46 1.46 0 0 0 13.99 3H2c-.325 0-.502.078-.602.145Z" />
      ) : (
        <path d="M6 12c0 .667-.083 1.167-.25 1.5H5a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-.75c-.167-.333-.25-.833-.25-1.5h4c2 0 2-2 2-2V4c0-2-2-2-2-2H2C0 2 0 4 0 4v6c0 2 2 2 2 2h4Z" />
      )}
    </svg>
  )
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode
  tone?: "neutral" | "active" | "warning"
}) {
  return (
    <span className={`participant-status participant-status--${tone}`}>
      {children}
    </span>
  )
}

export default function UserCard(user: UserCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [canScreenShare] = useState(() => {
    if (typeof navigator === "undefined") return false
    const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(
      navigator.userAgent
    )
    if (isMobileDevice) return false
    return typeof navigator.mediaDevices?.getDisplayMedia === "function"
  })

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = user.audioStream ?? null
    }
  }, [user.audioStream])

  const isSelf = user.peerId === LOCAL_PEER_ID
  const displayName = isSelf ? `${user.name} (ME)` : user.name
  const accent = participantAccent(user.name)
  const style = { "--participant-accent": accent } as CSSProperties
  const visibleCapabilities = (user.capabilities ?? []).slice(
    0,
    user.compact ? 2 : 3
  )
  const extraCapabilities = Math.max(
    0,
    (user.capabilities?.length ?? 0) - visibleCapabilities.length
  )

  return (
    <div className={`${user.className ?? ""} min-w-0`}>
      <article
        data-testid="participant-card"
        data-peer-id={user.peerId}
        data-participant-kind={user.kind}
        className={`participant-card ${
          user.compact ? "participant-card--compact" : ""
        }`}
        style={style}
      >
        <div className="participant-card__main">
          <div className="participant-card__avatar-wrap">
            <AudioVisualizer
              audio={user.audioStream}
              name={user.name}
              muteState={user.muteState}
            />
            <ParticipantAvatar
              name={user.name}
              kind={user.kind}
              size={user.compact ? "compact" : "full"}
              muted={Boolean(user.muteState)}
            />

            {!isSelf && user.muteState && (
              <span className="participant-card__corner participant-card__corner--mute">
                <MicIcon muted />
              </span>
            )}
            {user.screenShareEnabled && (
              <span className="participant-card__corner participant-card__corner--share">
                <ScreenIcon active />
              </span>
            )}
            {isSelf && (
              <button
                type="button"
                className={`participant-card__corner participant-card__corner--self ${
                  user.muteState ? "is-muted" : ""
                }`}
                onClick={user.onMuteSelf}
                title={user.muteState ? "Unmute" : "Mute"}
                aria-label={user.muteState ? "Unmute" : "Mute"}
              >
                <MicIcon muted={Boolean(user.muteState)} />
              </button>
            )}
            {isSelf && canScreenShare && user.screenshareAllowed && (
              <button
                type="button"
                className={`participant-card__corner participant-card__corner--screen ${
                  user.screenShareEnabled ? "is-active" : ""
                }`}
                onClick={user.onToggleScreenShare}
                title={
                  user.screenShareEnabled ? "Stop sharing" : "Share screen"
                }
                aria-label={
                  user.screenShareEnabled ? "Stop sharing" : "Share screen"
                }
              >
                <ScreenIcon active={Boolean(user.screenShareEnabled)} />
              </button>
            )}
          </div>

          <p className="participant-card__name" title={displayName}>
            {user.name}
            {isSelf && <span className="participant-card__me">ME</span>}
          </p>

          <div className="participant-card__status-row">
            <StatusPill>
              {user.kind === "agent" ? "🤖 Agent" : "Human"}
            </StatusPill>
            {user.screenShareEnabled && (
              <StatusPill tone="active">Sharing</StatusPill>
            )}
            {user.kind === "agent" && user.voiceEnabled && (
              <StatusPill tone="active">Voice</StatusPill>
            )}
          </div>
        </div>

        <div className="participant-card__details">
          {visibleCapabilities.map((capability) => (
            <span
              key={capability}
              title={capability}
              className="participant-capability"
            >
              {capability}
            </span>
          ))}
          {extraCapabilities > 0 && (
            <span className="participant-capability">+{extraCapabilities}</span>
          )}
          {user.kind === "agent" && (
            <button
              type="button"
              onClick={user.onToggleAgentVoice}
              disabled={!user.voiceAvailable}
              title={
                !user.voiceAvailable
                  ? "Voice unavailable"
                  : user.voiceEnabled
                  ? `Mute ${user.name}`
                  : `Enable voice for ${user.name}`
              }
              aria-label={
                !user.voiceAvailable
                  ? "Voice unavailable"
                  : user.voiceEnabled
                  ? `Mute ${user.name}`
                  : `Enable voice for ${user.name}`
              }
              className="participant-voice-button"
            >
              {user.voiceEnabled ? "◉ Voice" : "○ Voice"}
            </button>
          )}
        </div>

        <audio ref={audioRef} autoPlay={!isSelf} muted={isSelf} />
      </article>
    </div>
  )
}
