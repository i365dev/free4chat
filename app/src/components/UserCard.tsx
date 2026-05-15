import { useEffect, useRef } from "react"

import Avatar from "boring-avatars"

import { LOCAL_PEER_ID } from "@common/consts"
import { strToBgColor } from "@common/utils"
import { UserInfo } from "../common/types"
import AudioVisualizer from "../components/AudioVisualizer"

interface UserCardProps extends UserInfo {
  onMuteSelf?: () => void
  onToggleScreenShare?: () => void
}

export default function UserCard(user: UserCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

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

  return (
    <div className={user.className}>
      <div
        className="m-2 rounded-xl border border-gray-700 p-4 pb-2 pt-2"
        style={{ backgroundColor: strToBgColor(user.name) }}
      >
        <div className="items-center">
          <div className="flex flex-row">
            <Avatar size={40} variant="beam" name={user.name} />
            <button
              className="ml-auto"
              onClick={user.onToggleScreenShare}
              disabled={user.peerId !== LOCAL_PEER_ID}
            >
              {user.screenShareEnabled ? (
                <svg
                  className="bi bi-display"
                  fill="currentColor"
                  height="16"
                  viewBox="0 0 16 16"
                  width="16"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M0 4s0-2 2-2h12s2 0 2 2v6s0 2-2 2h-4c0 .667.083 1.167.25 1.5H11a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1h.75c.167-.333.25-.833.25-1.5H2s-2 0-2-2V4zm1.398-.855a.758.758 0 0 0-.254.302A1.46 1.46 0 0 0 1 4.01V10c0 .325.078.502.145.602.07.105.17.188.302.254a1.464 1.464 0 0 0 .538.143L2.01 11H14c.325 0 .502-.078.602-.145a.758.758 0 0 0 .254-.302 1.464 1.464 0 0 0 .143-.538L15 9.99V4c0-.325-.078-.502-.145-.602a.757.757 0 0 0-.302-.254A1.46 1.46 0 0 0 13.99 3H2c-.325 0-.502.078-.602.145z" />
                </svg>
              ) : (
                <svg
                  className="bi bi-display-fill"
                  fill="currentColor"
                  height="16"
                  viewBox="0 0 16 16"
                  width="16"
                  xmlns="http://www.w3.org/2000/svg"
                  opacity="0.4"
                >
                  <path d="M6 12c0 .667-.083 1.167-.25 1.5H5a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-.75C10.083 13.167 10 12.667 10 12h4c2 0 2-2 2-2V4c0-2-2-2-2-2H2C0 2 0 4 0 4v6c0 2 2 2 2 2h4z" />
                </svg>
              )}
            </button>
            <button
              className="ml-2"
              onClick={user.onMuteSelf}
              disabled={user.peerId !== LOCAL_PEER_ID}
            >
              {!user.muteState ? (
                <svg
                  className="bi bi-mic"
                  fill="currentColor"
                  height="16"
                  viewBox="0 0 16 16"
                  width="16"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z" />
                  <path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5zM8 0a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V3a3 3 0 0 0-3-3z" />
                </svg>
              ) : (
                <svg
                  className="bi bi-mic-mute"
                  fill="currentColor"
                  height="16"
                  viewBox="0 0 16 16"
                  width="16"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M13 8c0 .564-.094 1.107-.266 1.613l-.814-.814A4.02 4.02 0 0 0 12 8V7a.5.5 0 0 1 1 0v1zm-5 4c.818 0 1.578-.245 2.212-.667l.718.719a4.973 4.973 0 0 1-2.43.923V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 1 0v1a4 4 0 0 0 4 4zm3-9v4.879l-1-1V3a2 2 0 0 0-3.997-.118l-.845-.845A3.001 3.001 0 0 1 11 3z" />
                  <path d="m9.486 10.607-.748-.748A2 2 0 0 1 6 8v-.878l-1-1V8a3 3 0 0 0 4.486 2.607zm-7.84-9.253 12 12 .708-.708-12-12-.708.708z" />
                </svg>
              )}
            </button>
          </div>

          <div className="mt-2 text-center">
            <h5 className="text-sm font-normal text-white">
              {user.peerId === LOCAL_PEER_ID ? user.name + " (ME)" : user.name}
            </h5>
          </div>

          <audio
            ref={audioRef}
            autoPlay={user.peerId !== LOCAL_PEER_ID}
            muted={user.peerId === LOCAL_PEER_ID}
          />

          <AudioVisualizer
            audio={user.audioStream}
            name={user.name}
            muteState={user.muteState}
          />

          {user.screenShareStream && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="mt-2 w-full rounded-lg"
            />
          )}
        </div>
      </div>
    </div>
  )
}
