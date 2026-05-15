import { useState, useEffect, useCallback, useRef } from "react"

import { useRealtimeKitClient } from "@cloudflare/realtimekit-react"

import { LOCAL_PEER_ID } from "@common/consts"
import { UserInfo, Message } from "@common/types"

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed"

export function useChatRoom(
  roomName: string,
  nickName: string,
  roomType: "audio" | "screenshare"
) {
  const [meeting, initMeeting] = useRealtimeKitClient()
  const [participants, setParticipants] = useState<UserInfo[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState<string>("")
  const [expiryWarning, setExpiryWarning] = useState<string>("")
  const [resolvedRoomType, setResolvedRoomType] = useState<
    "audio" | "screenshare"
  >(roomType)
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting")
  const joinedMeetingRef = useRef<typeof meeting | null>(null)
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiryFinalRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!roomName || !nickName) return

    const controller = new AbortController()

    fetch(`/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: roomName, name: nickName, type: roomType }),
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.status === 410) throw new Error("room_expired")
        if (r.status === 429) throw new Error("rate_limited")
        if (!r.ok) throw new Error("server_error")
        return r.json()
      })
      .then(
        (data: { authToken: string; roomType?: "audio" | "screenshare" }) => {
          if (data.roomType) setResolvedRoomType(data.roomType)
          initMeeting({
            authToken: data.authToken,
            defaults: { audio: true, video: false },
          })
        }
      )
      .catch((err: Error) => {
        if (err.name === "AbortError") return
        setConnectionStatus("failed")
        if (err.message === "room_expired") {
          setError(
            "This room has expired (2-hour limit). Please open a new room."
          )
        } else if (err.message === "rate_limited") {
          setError("Too many requests. Please wait a moment and try again.")
        } else {
          setError("Failed to connect to server, please refresh")
        }
      })

    return () => controller.abort()
  }, [roomName, nickName, roomType])

  useEffect(() => {
    if (!meeting || joinedMeetingRef.current === meeting) return
    joinedMeetingRef.current = meeting

    const buildParticipants = () => {
      const list: UserInfo[] = []

      const self = meeting.self
      list.push({
        name: self.name,
        peerId: LOCAL_PEER_ID,
        room: roomName,
        muteState: !self.audioEnabled,
        audioStream: self.audioTrack
          ? new MediaStream([self.audioTrack])
          : null,
        screenShareEnabled: self.screenShareEnabled ?? false,
        screenShareStream:
          self.screenShareEnabled && self.screenShareTracks?.video
            ? new MediaStream([self.screenShareTracks.video])
            : null,
      })

      meeting.participants.joined.toArray().forEach((p) => {
        list.push({
          name: p.name,
          peerId: p.id,
          room: roomName,
          muteState: !p.audioEnabled,
          audioStream: p.audioTrack ? new MediaStream([p.audioTrack]) : null,
          screenShareEnabled: p.screenShareEnabled ?? false,
          screenShareStream:
            p.screenShareEnabled && p.screenShareTracks?.video
              ? new MediaStream([p.screenShareTracks.video])
              : null,
        })
      })

      setParticipants([...list])
      setConnectionStatus("connected")
    }

    const syncMessages = () => {
      const mapped: Message[] = meeting.chat.messages.map((m) => {
        const isSelf = m.userId === (meeting.self as any).userId
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

    const onRoomLeft = ({ state }: { state: string }) => {
      if (state === "disconnected") {
        setConnectionStatus("reconnecting")
      } else if (state === "failed") {
        setConnectionStatus("failed")
      }
    }

    const onRoomJoined = ({ reconnected }: { reconnected: boolean }) => {
      if (reconnected) {
        setConnectionStatus("connected")
        buildParticipants()
      }
    }

    const onSocketUpdate = ({ state }: { state: string }) => {
      if (state === "reconnecting") {
        setConnectionStatus("reconnecting")
      }
    }

    meeting.join().catch((err: Error) => {
      setConnectionStatus("failed")
      setError("Failed to join room: " + err.message)
    })

    expiryTimerRef.current = setTimeout(() => {
      setExpiryWarning(
        "This room will expire in 10 minutes. Copy the link and re-open to continue."
      )
    }, 6600 * 1000)

    expiryFinalRef.current = setTimeout(() => {
      setExpiryWarning(
        "Room session expired. Please re-open the link to rejoin."
      )
    }, 7200 * 1000)

    meeting.self.on("roomLeft", onRoomLeft)
    meeting.self.on("roomJoined", onRoomJoined)
    ;(meeting.meta as any).on("socketConnectionUpdate", onSocketUpdate)
    meeting.self.on("audioUpdate", buildParticipants)
    meeting.participants.joined.on("participantJoined", buildParticipants)
    meeting.participants.joined.on("participantLeft", buildParticipants)
    meeting.participants.joined.on("audioUpdate", buildParticipants)
    meeting.self.on("screenShareUpdate", buildParticipants)
    meeting.participants.joined.on("screenShareUpdate", buildParticipants)
    meeting.chat.on("chatUpdate", syncMessages)

    buildParticipants()

    return () => {
      meeting.self.off("roomLeft", onRoomLeft)
      meeting.self.off("roomJoined", onRoomJoined)
      ;(meeting.meta as any).off("socketConnectionUpdate", onSocketUpdate)
      meeting.self.off("audioUpdate", buildParticipants)
      meeting.participants.joined.off("participantJoined", buildParticipants)
      meeting.participants.joined.off("participantLeft", buildParticipants)
      meeting.participants.joined.off("audioUpdate", buildParticipants)
      meeting.self.off("screenShareUpdate", buildParticipants)
      meeting.participants.joined.off("screenShareUpdate", buildParticipants)
      meeting.chat.off("chatUpdate", syncMessages)
      meeting.leaveRoom()
      if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current)
      if (expiryFinalRef.current) clearTimeout(expiryFinalRef.current)
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

  const toggleScreenShare = useCallback(() => {
    if (!meeting) return
    if (meeting.self.screenShareEnabled) {
      meeting.self.disableScreenShare()
    } else {
      meeting.self.enableScreenShare()
    }
  }, [meeting])

  return {
    participants,
    messages,
    sendTextMessage,
    sendFileMessage,
    muteSelf,
    toggleScreenShare,
    error,
    expiryWarning,
    connectionStatus,
    resolvedRoomType,
  }
}
