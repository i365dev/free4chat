import { useEffect, useRef, useState } from "react"

import Avatar from "boring-avatars"

import { LOCAL_PEER_ID } from "@common/consts"
import { strToBgColor } from "@common/utils"

import { UserInfo } from "../common/types"
import AudioVisualizer from "../components/AudioVisualizer"

interface UserCardProps extends UserInfo {
  onMuteSelf?: () => void
  onToggleScreenShare?: () => void
  screenshareAllowed?: boolean
  compact?: boolean
}

export default function UserCard(user: UserCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [canScreenShare] = useState(() => {
    if (typeof navigator === "undefined") return false
    const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(
      navigator.userAgent
    )
    if (isMobileDevice) return false
    return typeof navigator.mediaDevices?.getDisplayMedia === "function"
  })

  const enterFullscreen = () => {
    const v = videoRef.current
    if (!v) return
    if (v.requestFullscreen) {
      v.requestFullscreen()
    } else if ((v as any).webkitEnterFullscreen) {
      ;(v as any).webkitEnterFullscreen()
    }
  }

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = user.audioStream ?? null
    }
  }, [user.audioStream])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = user.screenShareStream ?? null
    }
  }, [user.screenShareStream])

  const isSelf = user.peerId === LOCAL_PEER_ID
  const displayName = isSelf ? user.name + " (ME)" : user.name

  if (user.compact) {
    return (
      <div className={user.className}>
        <div
          className="flex flex-col items-center rounded-xl border border-gray-700 px-2 py-2"
          style={{ backgroundColor: strToBgColor(user.name) }}
        >
          <div className="relative">
            <Avatar size={36} variant="beam" name={user.name} />
            {user.muteState && (
              <span className="absolute -bottom-1 -right-1 rounded-full bg-gray-900 p-0.5">
                <svg
                  className="h-2.5 w-2.5 text-red-400"
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  <path d="M13 8c0 .564-.094 1.107-.266 1.613l-.814-.814A4.02 4.02 0 0 0 12 8V7a.5.5 0 0 1 1 0v1zm-5 4c.818 0 1.578-.245 2.212-.667l.718.719a4.973 4.973 0 0 1-2.43.923V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 1 0v1a4 4 0 0 0 4 4zm3-9v4.879l-1-1V3a2 2 0 0 0-3.997-.118l-.845-.845A3.001 3.001 0 0 1 11 3z" />
                  <path d="m9.486 10.607-.748-.748A2 2 0 0 1 6 8v-.878l-1-1V8a3 3 0 0 0 4.486 2.607zm-7.84-9.253 12 12 .708-.708-12-12-.708.708z" />
                </svg>
              </span>
            )}
            {user.screenShareEnabled && (
              <span className="absolute -bottom-1 -left-1 rounded-full bg-gray-900 p-0.5">
                <svg
                  className="h-2.5 w-2.5 text-green-400"
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  <path d="M0 4s0-2 2-2h12s2 0 2 2v6s0 2-2 2h-4c0 .667.083 1.167.25 1.5H11a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h.75c.167-.333.25-.833.25-1.5H2s-2 0-2-2V4z" />
                </svg>
              </span>
            )}
          </div>
          <p className="mt-1.5 w-full truncate text-center text-xs text-white">
            {displayName}
          </p>
          {isSelf && (
            <div className="mt-1 flex gap-1">
              <button
                className="opacity-50 transition-opacity hover:opacity-80"
                onClick={user.onMuteSelf}
              >
                {!user.muteState ? (
                  <svg
                    fill="currentColor"
                    height="12"
                    viewBox="0 0 16 16"
                    width="12"
                  >
                    <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z" />
                    <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5zM8 0a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V3a3 3 0 0 0-3-3z" />
                  </svg>
                ) : (
                  <svg
                    fill="currentColor"
                    height="12"
                    viewBox="0 0 16 16"
                    width="12"
                  >
                    <path d="M13 8c0 .564-.094 1.107-.266 1.613l-.814-.814A4.02 4.02 0 0 0 12 8V7a.5.5 0 0 1 1 0v1zm-5 4c.818 0 1.578-.245 2.212-.667l.718.719a4.973 4.973 0 0 1-2.43.923V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 1 0v1a4 4 0 0 0 4 4zm3-9v4.879l-1-1V3a2 2 0 0 0-3.997-.118l-.845-.845A3.001 3.001 0 0 1 11 3z" />
                    <path d="m9.486 10.607-.748-.748A2 2 0 0 1 6 8v-.878l-1-1V8a3 3 0 0 0 4.486 2.607zm-7.84-9.253 12 12 .708-.708-12-12-.708.708z" />
                  </svg>
                )}
              </button>
              {canScreenShare && user.screenshareAllowed && (
                <button
                  className="opacity-50 transition-opacity hover:opacity-80"
                  onClick={user.onToggleScreenShare}
                >
                  <svg
                    fill="currentColor"
                    height="12"
                    viewBox="0 0 16 16"
                    width="12"
                  >
                    <path d="M0 4s0-2 2-2h12s2 0 2 2v6s0 2-2 2h-4c0 .667.083 1.167.25 1.5H11a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h.75c.167-.333.25-.833.25-1.5H2s-2 0-2-2V4z" />
                  </svg>
                </button>
              )}
            </div>
          )}
          <audio ref={audioRef} autoPlay={!isSelf} muted={isSelf} />
        </div>
      </div>
    )
  }

  return (
    <div className={user.className}>
      <div
        className="flex w-full flex-col items-center justify-between overflow-hidden rounded-xl border border-gray-700 px-3 py-3"
        style={{ backgroundColor: strToBgColor(user.name) }}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <div className="relative">
            <Avatar size={56} variant="beam" name={user.name} />
            {!isSelf && user.muteState && (
              <span className="absolute -bottom-1 -right-1 rounded-full bg-gray-900 p-0.5">
                <svg
                  className="h-3 w-3 text-red-400"
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  <path d="M13 8c0 .564-.094 1.107-.266 1.613l-.814-.814A4.02 4.02 0 0 0 12 8V7a.5.5 0 0 1 1 0v1zm-5 4c.818 0 1.578-.245 2.212-.667l.718.719a4.973 4.973 0 0 1-2.43.923V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 1 0v1a4 4 0 0 0 4 4zm3-9v4.879l-1-1V3a2 2 0 0 0-3.997-.118l-.845-.845A3.001 3.001 0 0 1 11 3z" />
                  <path d="m9.486 10.607-.748-.748A2 2 0 0 1 6 8v-.878l-1-1V8a3 3 0 0 0 4.486 2.607zm-7.84-9.253 12 12 .708-.708-12-12-.708.708z" />
                </svg>
              </span>
            )}
            {isSelf && (
              <button
                className="absolute -bottom-1 -left-1 rounded-full bg-gray-900 p-0.5 opacity-70 transition-opacity hover:opacity-100"
                onClick={user.onMuteSelf}
                title={user.muteState ? "Unmute" : "Mute"}
              >
                {!user.muteState ? (
                  <svg
                    className="h-3 w-3 text-white"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z" />
                    <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5zM8 0a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V3a3 3 0 0 0-3-3z" />
                  </svg>
                ) : (
                  <svg
                    className="h-3 w-3 text-red-400"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M13 8c0 .564-.094 1.107-.266 1.613l-.814-.814A4.02 4.02 0 0 0 12 8V7a.5.5 0 0 1 1 0v1zm-5 4c.818 0 1.578-.245 2.212-.667l.718.719a4.973 4.973 0 0 1-2.43.923V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 1 0v1a4 4 0 0 0 4 4zm3-9v4.879l-1-1V3a2 2 0 0 0-3.997-.118l-.845-.845A3.001 3.001 0 0 1 11 3z" />
                    <path d="m9.486 10.607-.748-.748A2 2 0 0 1 6 8v-.878l-1-1V8a3 3 0 0 0 4.486 2.607zm-7.84-9.253 12 12 .708-.708-12-12-.708.708z" />
                  </svg>
                )}
              </button>
            )}
            {isSelf && canScreenShare && user.screenshareAllowed && (
              <button
                className="absolute -bottom-1 -right-1 rounded-full bg-gray-900 p-0.5 opacity-70 transition-opacity hover:opacity-100"
                onClick={user.onToggleScreenShare}
                title="Screen share"
              >
                <svg
                  className={`h-3 w-3 ${
                    user.screenShareEnabled ? "text-green-400" : "text-white"
                  }`}
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  {user.screenShareEnabled ? (
                    <path d="M0 4s0-2 2-2h12s2 0 2 2v6s0 2-2 2h-4c0 .667.083 1.167.25 1.5H11a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h.75c.167-.333.25-.833.25-1.5H2s-2 0-2-2V4zm1.398-.855a.758.758 0 0 0-.254.302A1.46 1.46 0 0 0 1 4.01V10c0 .325.078.502.145.602.07.105.17.188.302.254a1.464 1.464 0 0 0 .538.143L2.01 11H14c.325 0 .502-.078.602-.145a.758.758 0 0 0 .254-.302 1.464 1.464 0 0 0 .143-.538L15 9.99V4c0-.325-.078-.502-.145-.602a.757.757 0 0 0-.302-.254A1.46 1.46 0 0 0 13.99 3H2c-.325 0-.502.078-.602.145z" />
                  ) : (
                    <path d="M6 12c0 .667-.083 1.167-.25 1.5H5a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-.75C10.083 13.167 10 12.667 10 12h4c2 0 2-2 2-2V4c0-2-2-2-2-2H2C0 2 0 4 0 4v6c0 2 2 2 2 2h4z" />
                  )}
                </svg>
              </button>
            )}
          </div>

          <p
            className="w-full break-words text-center text-xs leading-tight text-white"
            title={displayName}
          >
            {isSelf ? user.name : displayName}
            {isSelf && (
              <span className="ml-1 rounded bg-black/30 px-1 py-0.5 text-[10px] text-white/70">
                ME
              </span>
            )}
          </p>
        </div>

        <div className="mb-1 flex min-h-[18px] items-center justify-center gap-1">
          <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[9px] text-white/50">
            Human
          </span>
        </div>

        <audio ref={audioRef} autoPlay={!isSelf} muted={isSelf} />

        <AudioVisualizer
          audio={user.audioStream}
          name={user.name}
          muteState={user.muteState}
        />
      </div>
    </div>
  )
}
