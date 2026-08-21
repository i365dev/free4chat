import { useCallback, useEffect, useRef, useState } from "react"

import { LOCAL_PEER_ID } from "@common/consts"
import { ActionType, Message, UserInfo } from "@common/types"

import type {
  SfuMessage,
  SfuParticipant,
  SfuRoomState,
  SfuSessionResponse,
  SfuTrack,
} from "../sfu/types"

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed"

interface SfuSession extends SfuSessionResponse {
  room: string
}

interface SfuServerMessage {
  type:
    | "state"
    | "trackPublished"
    | "participantUpdated"
    | "message"
    | "expired"
    | "error"
  state?: SfuRoomState
  participant?: Partial<SfuParticipant> & { track?: SfuTrack }
  message?: SfuMessage
  error?: string
}

const roomMessageToMessage = (message: SfuMessage): Message => ({
  peerId: message.peerId,
  name: message.name,
  type: message.type === "action" ? "action" : "text",
  text: message.text,
  actionType: message.actionType as ActionType | undefined,
  actionPayload: message.actionPayload,
})

export function useSfuChatRoom(
  roomName: string,
  nickName: string,
  roomType: "audio" | "screenshare",
  _enableBot?: boolean,
  enabled = true
) {
  const [participants, setParticipants] = useState<UserInfo[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState("")
  const [expiryWarning, setExpiryWarning] = useState("")
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting")
  const [timeLeft, setTimeLeft] = useState(2 * 60 * 60)
  const [resolvedRoomType] = useState<"audio" | "screenshare">(roomType)

  const sessionRef = useRef<SfuSession | null>(null)
  const roomStateRef = useRef<SfuRoomState | null>(null)
  const websocketRef = useRef<WebSocket | null>(null)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localAudioTrackRef = useRef<MediaStreamTrack | null>(null)
  const localScreenTrackRef = useRef<MediaStreamTrack | null>(null)
  const localScreenTrackNameRef = useRef("")
  const remoteAudioStreamsRef = useRef(new Map<string, MediaStream>())
  const remoteScreenStreamsRef = useRef(new Map<string, MediaStream>())
  const participantMapRef = useRef(new Map<string, SfuParticipant>())
  const subscribedTracksRef = useRef(new Set<string>())
  const pendingRemoteTrackRef = useRef<{
    peerId: string
    kind: "audio" | "video"
  } | null>(null)
  const negotiationQueueRef = useRef(Promise.resolve())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const closingRef = useRef(false)
  const expiresAtRef = useRef(0)

  const rebuildParticipants = useCallback(() => {
    const state = roomStateRef.current
    const session = sessionRef.current
    const localId = session?.participantId
    const list: UserInfo[] = []
    if (localId && session) {
      const local = participantMapRef.current.get(localId)
      list.push({
        name: local?.name ?? nickName,
        kind: local?.kind ?? "human",
        room: roomName,
        peerId: LOCAL_PEER_ID,
        muteState:
          local?.muted ?? !(localAudioTrackRef.current?.enabled ?? true),
        audioStream: localAudioTrackRef.current
          ? new MediaStream([localAudioTrackRef.current])
          : null,
        screenShareEnabled: Boolean(localScreenTrackRef.current),
        screenShareStream: localScreenTrackRef.current
          ? new MediaStream([localScreenTrackRef.current])
          : null,
      })
    }
    for (const participant of state?.participants ?? []) {
      if (participant.id === localId) continue
      const hasScreenShare = participant.tracks.some(
        (track) => track.kind === "video"
      )
      list.push({
        name: participant.name,
        kind: participant.kind,
        room: roomName,
        peerId: participant.id,
        muteState: participant.muted,
        audioStream: remoteAudioStreamsRef.current.get(participant.id) ?? null,
        screenShareEnabled: hasScreenShare,
        screenShareStream:
          remoteScreenStreamsRef.current.get(participant.id) ?? null,
      })
    }
    setParticipants(list)
  }, [nickName, roomName])

  const sendSocketMessage = useCallback((message: object) => {
    const socket = websocketRef.current
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message))
  }, [])

  const enqueueNegotiation = useCallback(
    <T>(operation: () => Promise<T>): Promise<T> => {
      const next = negotiationQueueRef.current.then(operation, operation)
      negotiationQueueRef.current = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
    []
  )

  const apiRequest = useCallback(async (path: string, body: object) => {
    const response = await fetch(`/api/sfu/${path}`, {
      method: path === "renegotiate" ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      throw new Error(data.error || `SFU request failed (${response.status})`)
    }
    const raw = await response.text()
    return (raw ? JSON.parse(raw) : {}) as {
      sessionDescription?: RTCSessionDescriptionInit
      tracks?: Array<{ trackName?: string }>
    }
  }, [])

  const publishTrack = useCallback(
    async (
      track: MediaStreamTrack,
      kind: "audio" | "video",
      trackName: string
    ) => {
      const pc = peerConnectionRef.current
      const session = sessionRef.current
      if (!pc || !session) return
      await enqueueNegotiation(async () => {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const transceiver = pc
          .getTransceivers()
          .find((item) => item.sender.track === track)
        if (!transceiver?.mid) throw new Error("SFU track mid unavailable")
        const response = await apiRequest("tracks", {
          room: roomName,
          participantId: session.participantId,
          token: session.participantToken,
          sessionId: session.sessionId,
          tracks: [
            { location: "local", trackName, kind, mid: transceiver.mid },
          ],
          sessionDescription: {
            type: offer.type,
            sdp: offer.sdp,
          },
        })
        if (response.sessionDescription) {
          await pc.setRemoteDescription(response.sessionDescription)
        }
      })
    },
    [apiRequest, enqueueNegotiation, roomName]
  )

  const subscribeTrack = useCallback(
    async (participant: SfuParticipant, track: SfuTrack) => {
      const session = sessionRef.current
      const pc = peerConnectionRef.current
      if (!session || !pc) return
      const key = `${participant.id}:${track.trackName}`
      if (subscribedTracksRef.current.has(key)) return
      subscribedTracksRef.current.add(key)
      await enqueueNegotiation(async () => {
        pendingRemoteTrackRef.current = {
          peerId: participant.id,
          kind: track.kind,
        }
        const response = await apiRequest("tracks", {
          room: roomName,
          participantId: session.participantId,
          token: session.participantToken,
          sessionId: session.sessionId,
          tracks: [
            {
              location: "remote",
              sessionId: participant.sessionId,
              trackName: track.trackName,
            },
          ],
        })
        if (!response.sessionDescription) return
        await pc.setRemoteDescription(response.sessionDescription)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await apiRequest("renegotiate", {
          room: roomName,
          participantId: session.participantId,
          token: session.participantToken,
          sessionId: session.sessionId,
          sessionDescription: { type: answer.type, sdp: answer.sdp },
        })
      }).catch(() => {
        subscribedTracksRef.current.delete(key)
      })
    },
    [apiRequest, enqueueNegotiation, roomName]
  )

  const applyRoomState = useCallback(
    (state: SfuRoomState) => {
      roomStateRef.current = state
      participantMapRef.current = new Map(
        state.participants.map((participant) => [
          participant.id,
          { ...participant, token: "" } as SfuParticipant,
        ])
      )
      setMessages(state.messages.map(roomMessageToMessage))
      expiresAtRef.current = state.expiresAt
      rebuildParticipants()
      const localId = sessionRef.current?.participantId
      for (const participant of state.participants) {
        if (participant.id === localId) continue
        const fullParticipant = participantMapRef.current.get(participant.id)
        if (!fullParticipant) continue
        for (const track of participant.tracks) {
          void subscribeTrack(fullParticipant, track)
        }
      }
    },
    [rebuildParticipants, subscribeTrack]
  )

  const connectWebSocket = useCallback(() => {
    const session = sessionRef.current
    if (!session || closingRef.current) return
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const url = new URL(`${protocol}//${window.location.host}/api/sfu/ws`)
    url.searchParams.set("room", session.room)
    url.searchParams.set("participantId", session.participantId)
    url.searchParams.set("token", session.participantToken)
    const socket = new WebSocket(url)
    websocketRef.current = socket
    socket.onopen = () => {
      reconnectAttemptsRef.current = 0
      setConnectionStatus("connected")
      setError("")
      sendSocketMessage({ type: "resync" })
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as SfuServerMessage
      if (message.type === "state" && message.state) {
        applyRoomState(message.state)
      } else if (
        message.type === "trackPublished" &&
        message.participant?.track
      ) {
        const current = participantMapRef.current.get(
          message.participant.id as string
        )
        if (current) {
          current.tracks = [...current.tracks, message.participant.track]
        } else if (
          message.participant.id &&
          message.participant.name &&
          message.participant.sessionId
        ) {
          participantMapRef.current.set(message.participant.id, {
            id: message.participant.id,
            name: message.participant.name,
            kind: message.participant.kind ?? "human",
            sessionId: message.participant.sessionId,
            muted: false,
            connected: true,
            tracks: [message.participant.track],
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
            token: "",
          })
        }
        const participant = participantMapRef.current.get(
          message.participant.id as string
        )
        rebuildParticipants()
        if (participant)
          void subscribeTrack(participant, message.participant.track)
      } else if (
        message.type === "participantUpdated" &&
        message.participant?.id
      ) {
        const participant = participantMapRef.current.get(
          message.participant.id
        )
        if (participant && typeof message.participant.muted === "boolean") {
          participant.muted = message.participant.muted
          rebuildParticipants()
        }
      } else if (message.type === "message" && message.message) {
        setMessages((previous) => [
          ...previous,
          roomMessageToMessage(message.message!),
        ])
      } else if (message.type === "expired") {
        setError(
          "This room has expired (2-hour limit). Please open a new room."
        )
        setConnectionStatus("failed")
      } else if (message.type === "error") {
        setError(message.error || "SFU room error")
      }
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (closingRef.current) return
      setConnectionStatus("reconnecting")
      const attempt = reconnectAttemptsRef.current++
      if (attempt >= 5) {
        setError("SFU connection lost. Reload to start a new session.")
        setConnectionStatus("failed")
        return
      }
      reconnectTimerRef.current = setTimeout(
        connectWebSocket,
        Math.min(1000 * 2 ** attempt, 8000)
      )
    }
  }, [applyRoomState, rebuildParticipants, sendSocketMessage, subscribeTrack])

  useEffect(() => {
    if (!enabled || !roomName || !nickName) return
    closingRef.current = false
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    })
    peerConnectionRef.current = pc
    pc.ontrack = (event) => {
      const pending = pendingRemoteTrackRef.current
      if (!pending) return
      const stream = event.streams[0] ?? new MediaStream([event.track])
      if (pending.kind === "video")
        remoteScreenStreamsRef.current.set(pending.peerId, stream)
      else remoteAudioStreamsRef.current.set(pending.peerId, stream)
      pendingRemoteTrackRef.current = null
      rebuildParticipants()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") setConnectionStatus("reconnecting")
    }

    const start = async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        })
        const audioTrack = media.getAudioTracks()[0]
        if (!audioTrack) throw new Error("No microphone track available")
        localAudioTrackRef.current = audioTrack
        pc.addTrack(audioTrack, media)
        rebuildParticipants()
        const response = await fetch("/api/sfu/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: roomName,
            name: nickName,
            kind: "human",
            turnstileToken: sessionStorage.getItem("ts_token") ?? undefined,
          }),
        })
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(data.error || "Unable to create SFU session")
        }
        const session = (await response.json()) as SfuSessionResponse
        sessionRef.current = { ...session, room: roomName }
        sessionStorage.removeItem("ts_token")
        expiresAtRef.current = session.expiresAt
        setTimeLeft(
          Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))
        )
        await publishTrack(
          audioTrack,
          "audio",
          `audio-${session.participantId}`
        )
        connectWebSocket()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to connect to SFU"
        )
        setConnectionStatus("failed")
      }
    }
    void start()

    const countdown = setInterval(() => {
      if (!expiresAtRef.current) return
      const remaining = Math.max(
        0,
        Math.floor((expiresAtRef.current - Date.now()) / 1000)
      )
      setTimeLeft(remaining)
      if (remaining > 0 && remaining <= 600) {
        setExpiryWarning(
          "This room will expire in 10 minutes. Copy the link and re-open to continue."
        )
      }
      if (remaining === 0) {
        setError(
          "This room has expired (2-hour limit). Please open a new room."
        )
        setConnectionStatus("failed")
      }
    }, 1000)

    return () => {
      closingRef.current = true
      clearInterval(countdown)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      sendSocketMessage({ type: "leave" })
      websocketRef.current?.close()
      localAudioTrackRef.current?.stop()
      localScreenTrackRef.current?.stop()
      peerConnectionRef.current?.close()
      peerConnectionRef.current = null
    }
  }, [
    connectWebSocket,
    enabled,
    nickName,
    publishTrack,
    rebuildParticipants,
    roomName,
    sendSocketMessage,
  ])

  const muteSelf = useCallback(() => {
    const track = localAudioTrackRef.current
    if (!track) return
    track.enabled = !track.enabled
    sendSocketMessage({ type: "mute", muted: !track.enabled })
    rebuildParticipants()
  }, [rebuildParticipants, sendSocketMessage])

  const toggleScreenShare = useCallback(async () => {
    const pc = peerConnectionRef.current
    const session = sessionRef.current
    if (!pc || !session) return
    if (localScreenTrackRef.current) {
      const trackName = localScreenTrackNameRef.current
      localScreenTrackRef.current.stop()
      localScreenTrackRef.current = null
      sendSocketMessage({ type: "unpublish", trackName })
      rebuildParticipants()
      return
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      const track = display.getVideoTracks()[0]
      if (!track) return
      localScreenTrackRef.current = track
      localScreenTrackNameRef.current = `screen-${session.participantId}`
      pc.addTrack(track, display)
      track.onended = () => {
        if (localScreenTrackRef.current === track) {
          localScreenTrackRef.current = null
          sendSocketMessage({
            type: "unpublish",
            trackName: localScreenTrackNameRef.current,
          })
          rebuildParticipants()
        }
      }
      rebuildParticipants()
      await publishTrack(track, "video", localScreenTrackNameRef.current)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Screen sharing was not started"
      )
    }
  }, [publishTrack, rebuildParticipants, sendSocketMessage])

  const sendTextMessage = useCallback(
    (text: string) => {
      sendSocketMessage({ type: "chat", text })
    },
    [sendSocketMessage]
  )

  const sendActionMessage = useCallback(
    (actionType: ActionType, actionPayload: Record<string, string>) => {
      sendSocketMessage({ type: "action", actionType, actionPayload })
    },
    [sendSocketMessage]
  )

  const sendFileMessage = useCallback(async (_file: File) => {
    throw new Error("File transfer is not available on the SFU test path yet.")
  }, [])

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
    botEnabled: false,
    timeLeft,
  }
}
