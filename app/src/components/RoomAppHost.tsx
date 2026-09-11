import { useCallback, useEffect, useRef, useState } from "react"

import {
  decodeRoomAppClientMessage,
  isRoomAppAllowlisted,
  projectRoomAppParticipants,
  serializedRoomAppBytes,
  validateRoomAppDefinition,
  type RoomAppDefinition,
  type RoomAppHostMessage,
  type RoomAppParticipantProjection,
  type RoomAppTransportEnvelope,
} from "../common/roomApp"

interface RoomAppHostProps {
  app: RoomAppDefinition
  appInstanceId: string
  self: RoomAppParticipantProjection
  participants: RoomAppParticipantProjection[]
  subscribe: (
    listener: (message: RoomAppTransportEnvelope) => void
  ) => () => void
  send: (
    lane: "reliable" | "realtime",
    appInstanceId: string,
    payload: Record<string, unknown>
  ) => boolean
  onClose: () => void
}

function handshakeToken(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

export default function RoomAppHost({
  app,
  appInstanceId,
  self,
  participants,
  subscribe,
  send,
  onClose,
}: RoomAppHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const tokenRef = useRef(handshakeToken())
  const readyRef = useRef(false)
  const previousParticipantsRef = useRef<RoomAppParticipantProjection[]>([])
  const sendRef = useRef(send)
  sendRef.current = send
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  const post = useCallback((message: RoomAppHostMessage) => {
    try {
      portRef.current?.postMessage(message)
    } catch {
      setFailed(true)
    }
  }, [])

  const sendBootstrap = useCallback(() => {
    const frame = iframeRef.current
    if (!frame?.contentWindow) return
    tokenRef.current = handshakeToken()
    readyRef.current = false
    setReady(false)
    const channel = new MessageChannel()
    const port = channel.port1
    portRef.current?.close()
    portRef.current = port
    port.start()
    port.onmessage = (event) => {
      const message = decodeRoomAppClientMessage(event.data, appInstanceId)
      if (!message) {
        post({
          type: "error",
          appInstanceId,
          error: "unsupported_message",
        })
        return
      }
      if (message.type === "ready") {
        if (message.handshakeToken !== tokenRef.current) {
          setFailed(true)
          return
        }
        readyRef.current = true
        setReady(true)
        const projected = projectRoomAppParticipants(participants)
        previousParticipantsRef.current = projected
        post({
          type: "ready",
          protocolVersion: 1,
          appInstanceId,
          self,
          participants: projected,
        })
        return
      }
      const serializedBytes = serializedRoomAppBytes(message.payload)
      if (serializedBytes === null) return
      const lane = message.type === "sendReliable" ? "reliable" : "realtime"
      if (!sendRef.current(lane, appInstanceId, message.payload))
        post({ type: "error", appInstanceId, error: "rate_limited" })
    }
    frame.contentWindow.postMessage(
      {
        type: "room-app-bootstrap",
        protocolVersion: 1,
        appInstanceId,
        handshakeToken: tokenRef.current,
      },
      app.origin === window.location.origin ? app.origin : "*",
      [channel.port2]
    )
  }, [app.origin, appInstanceId, participants, post, self])

  useEffect(() => {
    if (!validateRoomAppDefinition(app) || !isRoomAppAllowlisted(app)) {
      setFailed(true)
      return
    }
    return () => {
      readyRef.current = false
      portRef.current?.close()
      portRef.current = null
    }
  }, [app])

  useEffect(() => {
    return subscribe((message) => {
      if (!readyRef.current || message.appInstanceId !== appInstanceId) return
      post({
        type: message.lane,
        appInstanceId,
        payload: message.payload,
      })
    })
  }, [appInstanceId, post, subscribe])

  useEffect(() => {
    const next = projectRoomAppParticipants(participants)
    const previous = previousParticipantsRef.current
    if (!readyRef.current) {
      previousParticipantsRef.current = next
      return
    }
    const previousById = new Map(
      previous.map((participant) => [participant.participantId, participant])
    )
    const nextById = new Map(
      next.map((participant) => [participant.participantId, participant])
    )
    for (const participant of next) {
      if (!previousById.has(participant.participantId))
        post({
          type: "participant_join",
          appInstanceId,
          participant,
        })
    }
    for (const participant of previous) {
      if (!nextById.has(participant.participantId))
        post({
          type: "participant_leave",
          appInstanceId,
          participant,
        })
    }
    previousParticipantsRef.current = next
  }, [appInstanceId, participants, post])

  if (!validateRoomAppDefinition(app) || !isRoomAppAllowlisted(app))
    return <div role="alert">This Room App is not allowlisted.</div>

  return (
    <section
      aria-label={app.label}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-gray-950"
      data-testid="room-app-host"
    >
      <div className="flex flex-none items-center justify-between border-b border-gray-800 px-3 py-2 text-xs text-gray-300">
        <span>{app.label}</span>
        <div className="flex items-center gap-2">
          <span aria-live="polite">
            {failed ? "unavailable" : ready ? "ready" : "connecting…"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-gray-400 hover:bg-gray-800 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
      {failed ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-gray-400">
          This Room App is unavailable. The Room is still usable.
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title={app.label}
          src={app.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow=""
          onLoad={sendBootstrap}
          onError={() => setFailed(true)}
          className="min-h-0 flex-1 border-0"
          data-testid="room-app-iframe"
        />
      )}
    </section>
  )
}
