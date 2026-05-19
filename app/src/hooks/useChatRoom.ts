import { useState, useEffect, useCallback, useRef } from "react"

import { useRealtimeKitClient } from "@cloudflare/realtimekit-react"

import { LOCAL_PEER_ID } from "@common/consts"
import { UserInfo, Message, ActionType } from "@common/types"

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed"

export function useChatRoom(
  roomName: string,
  nickName: string,
  roomType: "audio" | "screenshare",
  enableBot?: boolean
) {
  const [meeting, initMeeting] = useRealtimeKitClient()
  const [participants, setParticipants] = useState<UserInfo[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState<string>("")
  const [expiryWarning, setExpiryWarning] = useState<string>("")
  const [botEnabled, setBotEnabled] = useState<boolean>(false)
  const [resolvedRoomType, setResolvedRoomType] = useState<
    "audio" | "screenshare"
  >(roomType)
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting")
  const [timeLeft, setTimeLeft] = useState<number>(2 * 60 * 60)
  const expiresAtRef = useRef<number>(0)
  const joinedMeetingRef = useRef<typeof meeting | null>(null)
  const hasJoinedRef = useRef(false)
  const hasLeftRef = useRef(false)
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiryFinalRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!roomName || !nickName) return

    const controller = new AbortController()

    fetch(`/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomName,
        name: nickName,
        type: roomType,
        enableBot: enableBot ?? false,
        turnstileToken: sessionStorage.getItem("ts_token") ?? undefined,
      }),
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.status === 410) throw new Error("room_expired")
        if (r.status === 429) throw new Error("rate_limited")
        if (r.status === 403) throw new Error("verification_failed")
        if (!r.ok) throw new Error("server_error")
        return r.json()
      })
      .then(
        (data: {
          authToken: string
          roomType?: "audio" | "screenshare"
          typeConflict?: boolean
          botEnabled?: boolean
          expiresAt?: number
        }) => {
          setError("")
          sessionStorage.removeItem("ts_token")
          if (data.expiresAt) {
            expiresAtRef.current = data.expiresAt
            setTimeLeft(
              Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000))
            )
          }
          if (data.roomType) setResolvedRoomType(data.roomType)
          if (data.botEnabled) setBotEnabled(true)
          if (data.typeConflict) {
            setError(
              data.roomType === "audio"
                ? "This room was created as audio-only. Screen sharing is not available."
                : "This room was created with screen sharing enabled."
            )
          }
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
        } else if (err.message === "verification_failed") {
          sessionStorage.removeItem("ts_token")
          setError("Bot verification expired. Please refresh the page.")
        } else {
          setError("Failed to connect to server, please refresh")
        }
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          const text = (m as any).message as string
          if (text.startsWith("__action:")) {
            try {
              const payload = JSON.parse(text.slice(9))
              return {
                ...base,
                type: "action" as const,
                actionType: payload.actionType as ActionType,
                actionPayload: payload.actionPayload,
              }
            } catch {
              return { ...base, type: "text" as const, text }
            }
          }
          if (text.startsWith("__bot:")) {
            try {
              const payload = JSON.parse(text.slice(6))
              const botText =
                typeof payload.text === "string" ? payload.text : ""
              return {
                peerId: "luna-ai",
                name: "Luna · AI",
                type: "bot" as const,
                text: botText,
              }
            } catch {
              return { ...base, type: "text" as const, text }
            }
          }
          return { ...base, type: "text" as const, text }
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

    const doExpireLeave = () => {
      if (hasLeftRef.current) return
      hasLeftRef.current = true
      setExpiryWarning(
        "Room session expired. Please re-open the link to rejoin."
      )
      meeting.leaveRoom().catch(() => {})
      if (typeof window !== "undefined") {
        window.location.href = "/"
      }
    }

    const onRoomLeft = ({ state }: { state: string }) => {
      if (hasLeftRef.current) return
      const isExpired =
        expiresAtRef.current > 0 && Date.now() >= expiresAtRef.current
      if (isExpired) {
        doExpireLeave()
        return
      }
      if (state === "disconnected") {
        setConnectionStatus("reconnecting")
      } else if (state === "failed") {
        setConnectionStatus("failed")
      }
    }

    const onRoomJoined = ({ reconnected }: { reconnected: boolean }) => {
      if (reconnected) {
        setError("")
        setConnectionStatus("connected")
        buildParticipants()
      }
      syncMessages()
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
    hasJoinedRef.current = true

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && expiresAtRef.current > 0) {
        const remaining = Math.max(
          0,
          Math.floor((expiresAtRef.current - Date.now()) / 1000)
        )
        setTimeLeft(remaining)
        if (remaining === 0) doExpireLeave()
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    countdownRef.current = setInterval(() => {
      const base = expiresAtRef.current
      if (!base) return
      const remaining = Math.max(0, Math.floor((base - Date.now()) / 1000))
      setTimeLeft(remaining)
      if (remaining === 0) {
        clearInterval(countdownRef.current!)
        countdownRef.current = null
        doExpireLeave()
      }
    }, 1000)

    const scheduleWarning = () => {
      if (!expiresAtRef.current) return
      const warnDelay = expiresAtRef.current - Date.now() - 10 * 60 * 1000
      if (warnDelay <= 0) {
        setExpiryWarning(
          "This room will expire in 10 minutes. Copy the link and re-open to continue."
        )
        return
      }
      expiryTimerRef.current = setTimeout(() => {
        setExpiryWarning(
          "This room will expire in 10 minutes. Copy the link and re-open to continue."
        )
      }, warnDelay)
    }
    scheduleWarning()

    const finalDelay = expiresAtRef.current
      ? Math.max(0, expiresAtRef.current - Date.now())
      : 7200 * 1000
    expiryFinalRef.current = setTimeout(doExpireLeave, finalDelay)

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
      document.removeEventListener("visibilitychange", onVisibilityChange)
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
      if (hasJoinedRef.current && !hasLeftRef.current) meeting.leaveRoom()
      hasJoinedRef.current = false
      hasLeftRef.current = false
      if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current)
      if (expiryFinalRef.current) clearTimeout(expiryFinalRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
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
    (file: File): Promise<void> => {
      if (!meeting) return Promise.resolve()
      if (file.type.startsWith("image/")) {
        return meeting.chat.sendImageMessage(file)
      } else {
        return meeting.chat.sendFileMessage(file)
      }
    },
    [meeting]
  )

  const sendActionMessage = useCallback(
    (actionType: ActionType, actionPayload: Record<string, string>) => {
      if (!meeting) return
      meeting.chat.sendTextMessage(
        "__action:" + JSON.stringify({ actionType, actionPayload })
      )
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
    sendActionMessage,
    muteSelf,
    toggleScreenShare,
    error,
    expiryWarning,
    connectionStatus,
    resolvedRoomType,
    botEnabled,
    timeLeft,
  }
}
