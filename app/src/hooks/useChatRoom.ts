import { useState, useEffect, useCallback, useRef } from "react"
import { useRealtimeKitClient } from "@cloudflare/realtimekit-react"

import { LOCAL_PEER_ID, GET_WORKER_URL } from "@common/consts"
import { UserInfo, Message } from "@common/types"

export function useChatRoom(roomName: string, nickName: string) {
  const [meeting, initMeeting] = useRealtimeKitClient()
  const [participants, setParticipants] = useState<UserInfo[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState<string>("")
  const joinedRef = useRef(false)

  useEffect(() => {
    if (!roomName || !nickName) return

    fetch(`${GET_WORKER_URL()}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: roomName, name: nickName }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: { authToken: string }) => {
        initMeeting({
          authToken: data.authToken,
          defaults: { audio: true, video: false },
        })
      })
      .catch(() => setError("Failed to connect to server, please refresh"))
  }, [roomName, nickName])

  useEffect(() => {
    if (!meeting || joinedRef.current) return
    joinedRef.current = true

    const buildParticipants = () => {
      const list: UserInfo[] = []

      const self = meeting.self
      list.push({
        name: self.name,
        peerId: LOCAL_PEER_ID,
        room: roomName,
        muteState: !self.audioEnabled,
        audioStream: self.audioTrack ? new MediaStream([self.audioTrack]) : null,
      })

      meeting.participants.joined.toArray().forEach((p) => {
        list.push({
          name: p.name,
          peerId: p.id,
          room: roomName,
          muteState: !p.audioEnabled,
          audioStream: p.audioTrack ? new MediaStream([p.audioTrack]) : null,
        })
      })

      setParticipants([...list])
    }

    const syncMessages = () => {
      const mapped: Message[] = meeting.chat.messages.map((m) => {
        const isSelf = m.userId === meeting.self.id
        const base = {
          peerId: isSelf ? LOCAL_PEER_ID : m.userId,
          name: m.displayName,
        }
        if (m.type === "text") {
          return { ...base, type: "text" as const, text: (m as any).message }
        }
        if (m.type === "image") {
          return {
            ...base,
            type: "image" as const,
            fileLink: (m as any).link,
            fileName: "image",
          }
        }
        return {
          ...base,
          type: "file" as const,
          fileLink: (m as any).link,
          fileName: (m as any).name,
          fileSize: (m as any).size,
        }
      })
      setMessages([...mapped])
    }

    meeting.join()

    meeting.self.on("audioUpdate", buildParticipants)
    meeting.participants.joined.on("participantJoined", buildParticipants)
    meeting.participants.joined.on("participantLeft", buildParticipants)
    meeting.participants.joined.on("audioUpdate", buildParticipants)

    meeting.chat.on("chatUpdate", syncMessages)

    buildParticipants()

    return () => {
      meeting.leaveRoom()
      joinedRef.current = false
    }
  }, [meeting, roomName])

  const sendTextMessage = useCallback(
    (text: string) => {
      if (!meeting) return
      meeting.chat.sendTextMessage(text)
    },
    [meeting]
  )

  const sendFileMessage = useCallback(
    (file: File) => {
      if (!meeting) return
      if (file.type.startsWith("image/")) {
        meeting.chat.sendImageMessage(file)
      } else {
        meeting.chat.sendFileMessage(file)
      }
    },
    [meeting]
  )

  const muteSelf = useCallback(() => {
    if (!meeting) return
    if (meeting.self.audioEnabled) {
      meeting.self.disableAudio()
    } else {
      meeting.self.enableAudio()
    }
  }, [meeting])

  return { participants, messages, sendTextMessage, sendFileMessage, muteSelf, error }
}
