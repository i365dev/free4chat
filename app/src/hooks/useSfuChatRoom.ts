import { useCallback, useEffect, useRef, useState } from "react"

import { LOCAL_PEER_ID } from "@common/consts"
import { mergeRoomAndEphemeralMessages } from "@common/messageReconciliation"
import {
  validateRoomAttachmentRead,
  validateUploadedRoomAttachment,
} from "@common/roomAttachments"
import { ActionType, Message, UserInfo } from "@common/types"
import {
  MAX_COLLAB_ATTACHMENT_REFS,
  MAX_COLLAB_SUMMARY_LENGTH,
  validateAdvertisedCapabilities,
} from "@do/collab"

import type { RoomAttachmentRead } from "../room/types"
import type {
  SfuMeetingNotesState,
  SfuVoiceReplyState,
  SfuMessage,
  SfuParticipant,
  SfuRoomState,
  SfuSessionResponse,
  SfuTrack,
} from "../sfu/types"

type ConnectionStatus =
  | "verifying"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "verification_failed"
  | "failed"

class TurnstileVerificationError extends Error {
  constructor(message = "Verification failed") {
    super(message)
    this.name = "TurnstileVerificationError"
  }
}

const MAX_FILE_SIZE = 20 * 1024 * 1024
const FILE_CHUNK_SIZE = 32 * 1024
const FILE_BUFFER_HIGH_WATER_MARK = 256 * 1024
const FILE_BUFFER_LOW_WATER_MARK = 64 * 1024
const MAX_AGENT_ATTACHMENT_BYTES = 768 * 1024
const AGENT_IMAGE_MAX_DIMENSION = 1600
const AGENT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])
const AGENT_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/yaml",
])
const AGENT_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".yml",
  ".yaml",
])

function agentTextMime(file: File): string | undefined {
  if (AGENT_TEXT_TYPES.has(file.type)) return file.type
  const name = file.name.toLowerCase()
  const dot = name.lastIndexOf(".")
  const ext = dot >= 0 ? name.slice(dot) : ""
  if (!AGENT_TEXT_EXTENSIONS.has(ext)) return undefined
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
      ".log": "text/plain",
      ".yml": "text/yaml",
      ".yaml": "text/yaml",
    }[ext] ?? "text/plain"
  )
}

interface IncomingFileTransfer {
  id: string
  name: string
  mime: string
  size: number
  received: number
  chunks: ArrayBuffer[]
}

interface SfuApiResponse {
  dataChannels?: Array<{ id?: number }>
  errorCode?: string
  requiresImmediateRenegotiation?: boolean
  sessionDescription?: RTCSessionDescriptionInit
  tracks?: Array<{
    errorCode?: string
    errorDescription?: string
    mid?: string
    trackName?: string
  }>
}

function summarizeRemoteTrackResponse(response: SfuApiResponse) {
  const tracks = Array.isArray(response.tracks) ? response.tracks : []
  return {
    requiresImmediateRenegotiation:
      response.requiresImmediateRenegotiation === true,
    hasSessionDescription: Boolean(response.sessionDescription),
    sessionDescriptionType: response.sessionDescription?.type ?? null,
    trackResultCount: tracks.length,
    trackHasMid: tracks.some(
      (track) => typeof track.mid === "string" && track.mid.length > 0
    ),
    topLevelErrorCode:
      typeof response.errorCode === "string"
        ? response.errorCode.slice(0, 64)
        : undefined,
    trackErrorCodes: tracks
      .map((track) =>
        typeof track.errorCode === "string"
          ? track.errorCode.slice(0, 64)
          : undefined
      )
      .filter((code): code is string => Boolean(code))
      .slice(0, 4),
  }
}

function isAgentImage(file: File): boolean {
  return AGENT_IMAGE_TYPES.has(file.type)
}

/** Text-like files are uploaded for read_attachment too; the MCP layer
 * returns them as decoded text instead of ImageContent. */
function isAgentTextFile(file: File): boolean {
  return (
    file.size > 0 &&
    file.size <= MAX_AGENT_ATTACHMENT_BYTES &&
    agentTextMime(file) !== undefined
  )
}

async function createAgentVisionCopy(file: File): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = sourceUrl
    await image.decode()
    const sourceWidth = image.naturalWidth
    const sourceHeight = image.naturalHeight
    if (
      sourceWidth <= AGENT_IMAGE_MAX_DIMENSION &&
      sourceHeight <= AGENT_IMAGE_MAX_DIMENSION &&
      file.size <= MAX_AGENT_ATTACHMENT_BYTES
    )
      return file.slice(0, file.size, file.type)

    let scale = Math.min(
      1,
      AGENT_IMAGE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight)
    )
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.round(sourceWidth * scale))
      canvas.height = Math.max(1, Math.round(sourceHeight * scale))
      const context = canvas.getContext("2d")
      if (!context) throw new Error("Canvas is unavailable")
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.82, 0.68, 0.52, 0.38]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality)
        )
        if (blob && blob.size <= MAX_AGENT_ATTACHMENT_BYTES) return blob
      }
      scale *= 0.75
    }
    throw new Error("Image is too large for Agent vision")
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

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
  participant?: Partial<SfuParticipant> & {
    track?: SfuTrack
    sessionId?: string
    muted?: boolean
    fileChannelReady?: boolean
  }
  message?: SfuMessage
  error?: string
}

const roomMessageToMessage = (
  message: SfuMessage,
  localParticipantId?: string
): Message => {
  return {
    peerId:
      message.peerId === localParticipantId ? LOCAL_PEER_ID : message.peerId,
    name: message.name,
    kind: message.kind,
    type: message.type === "action" ? "action" : "text",
    messageId: message.id,
    createdAt: message.createdAt,
    sequence: message.sequence,
    text: message.text,
    actionType: message.actionType as ActionType | undefined,
    actionPayload: message.actionPayload,
    collab: message.collab,
  }
}

export interface UseSfuChatRoomOptions {
  enabled?: boolean
  /**
   * Called only when creating a brand-new Human SFU session (never on
   * reconnect). Must resolve with a fresh, single-use Turnstile token.
   */
  getTurnstileToken?: () => Promise<string>
}

export function useSfuChatRoom(
  roomName: string,
  nickName: string,
  roomType: "audio" | "screenshare",
  options: UseSfuChatRoomOptions = {}
) {
  const { enabled = true, getTurnstileToken } = options
  const [participants, setParticipants] = useState<UserInfo[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState("")
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("verifying")
  const [resolvedRoomType] = useState<"audio" | "screenshare">(roomType)
  const [meetingNotes, setMeetingNotes] = useState<SfuMeetingNotesState>({
    active: false,
  })
  // Whether the server-side media capability is even on in this
  // environment — independent of any specific grant. Starts `false` so the
  // Start control stays hidden/disabled until the first real room state
  // arrives, rather than defaulting to an optimistic "available".
  const [meetingNotesMediaAvailable, setMeetingNotesMediaAvailable] =
    useState(false)
  const [voiceReply, setVoiceReply] = useState<SfuVoiceReplyState>({
    active: false,
  })
  const [voiceReplyMediaAvailable, setVoiceReplyMediaAvailable] =
    useState(false)

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
    sessionId: string
  } | null>(null)
  const negotiationQueueRef = useRef(Promise.resolve())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const mediaReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const mediaReconnectAttemptsRef = useRef(0)
  const mediaReconnectPromiseRef = useRef<Promise<void> | null>(null)
  const mediaReconnectRef = useRef<(() => Promise<void>) | null>(null)
  const initialConnectRef = useRef<(() => Promise<void>) | null>(null)
  const localFileChannelRef = useRef<RTCDataChannel | null>(null)
  const remoteFileChannelsRef = useRef(new Map<string, RTCDataChannel>())
  const remoteFileChannelIdsRef = useRef(new Map<string, number>())
  const dataChannelsRef = useRef(new Set<RTCDataChannel>())
  const dataChannelIdsRef = useRef(new Set<number>())
  const localFileChannelIdRef = useRef<number | null>(null)
  const localTrackMidsRef = useRef(new Map<string, string>())
  const incomingFilesRef = useRef(new Map<string, IncomingFileTransfer>())
  const objectUrlsRef = useRef(new Set<string>())
  const roomMessagesRef = useRef<Message[]>([])
  const ephemeralMessagesRef = useRef<Message[]>([])
  const fileSendQueueRef = useRef(Promise.resolve())
  const dataChannelReadyRef = useRef(false)
  const closingRef = useRef(false)

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
          local?.media?.muted ?? !(localAudioTrackRef.current?.enabled ?? true),
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
      const hasScreenShare = (participant.media?.tracks ?? []).some(
        (track) => track.kind === "video"
      )
      list.push({
        name: participant.name,
        kind: participant.kind,
        room: roomName,
        peerId: participant.id,
        muteState: participant.media?.muted,
        capabilities:
          participant.kind === "agent"
            ? participant.capabilities?.advertised
            : participant.advertised,
        surface: participant.kind === "agent" ? participant.surface : undefined,
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
    const method =
      path === "renegotiate" || path.endsWith("/close") ? "PUT" : "POST"
    const response = await fetch(`/api/sfu/${path}`, {
      method,
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
    return (raw ? JSON.parse(raw) : {}) as SfuApiResponse
  }, [])

  const closeDataChannels = useCallback(
    async (session: SfuSession | null = sessionRef.current) => {
      if (!session || dataChannelIdsRef.current.size === 0) return
      const dataChannels = [...dataChannelIdsRef.current].map((id) => ({ id }))
      try {
        await apiRequest("datachannels/close", {
          room: roomName,
          participantId: session.participantId,
          token: session.participantToken,
          sessionId: session.sessionId,
          dataChannels,
        })
      } catch {
        // The SFU session may already be gone during network recovery.
      } finally {
        dataChannelIdsRef.current.clear()
        localFileChannelIdRef.current = null
        remoteFileChannelIdsRef.current.clear()
      }
    },
    [apiRequest, roomName]
  )

  const waitForDataChannelOpen = useCallback(
    (channel: RTCDataChannel): Promise<void> => {
      if (channel.readyState === "open") return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup()
          reject(new Error("SFU data channel timed out"))
        }, 10000)
        const cleanup = () => {
          window.clearTimeout(timeout)
          channel.removeEventListener("open", onOpen)
          channel.removeEventListener("close", onClose)
          channel.removeEventListener("error", onError)
        }
        const onOpen = () => {
          cleanup()
          resolve()
        }
        const onClose = () => {
          cleanup()
          reject(new Error("SFU data channel closed"))
        }
        const onError = () => {
          cleanup()
          reject(new Error("SFU data channel failed"))
        }
        channel.addEventListener("open", onOpen)
        channel.addEventListener("close", onClose)
        channel.addEventListener("error", onError)
      })
    },
    []
  )

  const waitForSendCapacity = useCallback(
    (channel: RTCDataChannel): Promise<void> => {
      if (channel.bufferedAmount <= FILE_BUFFER_HIGH_WATER_MARK)
        return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup()
          reject(new Error("SFU data channel backpressure timeout"))
        }, 10000)
        const cleanup = () => {
          window.clearTimeout(timeout)
          channel.removeEventListener("bufferedamountlow", onLow)
          channel.removeEventListener("close", onClose)
          channel.removeEventListener("error", onError)
        }
        const onLow = () => {
          cleanup()
          resolve()
        }
        const onClose = () => {
          cleanup()
          reject(new Error("SFU data channel closed"))
        }
        const onError = () => {
          cleanup()
          reject(new Error("SFU data channel failed"))
        }
        channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_MARK
        channel.addEventListener("bufferedamountlow", onLow)
        channel.addEventListener("close", onClose)
        channel.addEventListener("error", onError)
      })
    },
    []
  )

  const replaceRoomMessages = useCallback((nextMessages: Message[]) => {
    roomMessagesRef.current = nextMessages
    setMessages(
      mergeRoomAndEphemeralMessages(
        roomMessagesRef.current,
        ephemeralMessagesRef.current
      )
    )
  }, [])

  const appendRoomMessage = useCallback((message: Message) => {
    roomMessagesRef.current = [...roomMessagesRef.current, message]
    setMessages(
      mergeRoomAndEphemeralMessages(
        roomMessagesRef.current,
        ephemeralMessagesRef.current
      )
    )
  }, [])

  const appendEphemeralMessage = useCallback((message: Message) => {
    if (
      message.messageId &&
      ephemeralMessagesRef.current.some(
        (existing) => existing.messageId === message.messageId
      )
    )
      return
    ephemeralMessagesRef.current = [
      ...ephemeralMessagesRef.current,
      { ...message, ephemeral: true },
    ]
    setMessages(
      mergeRoomAndEphemeralMessages(
        roomMessagesRef.current,
        ephemeralMessagesRef.current
      )
    )
  }, [])

  const addReceivedFileMessage = useCallback(
    (
      peerId: string,
      name: string,
      file: Pick<IncomingFileTransfer, "id" | "name" | "mime" | "size">,
      chunks: ArrayBuffer[]
    ) => {
      const blob = new Blob(chunks, { type: file.mime })
      const fileLink = URL.createObjectURL(blob)
      objectUrlsRef.current.add(fileLink)
      appendEphemeralMessage({
        peerId,
        name,
        type: file.mime.startsWith("image/") ? "image" : "file",
        messageId: file.id,
        createdAt: Date.now(),
        fileLink,
        fileName: file.name,
        fileSize: file.size,
      })
    },
    [appendEphemeralMessage]
  )

  const resetRemoteParticipant = useCallback((participantId: string) => {
    for (const key of subscribedTracksRef.current) {
      if (key.startsWith(`${participantId}:`))
        subscribedTracksRef.current.delete(key)
    }

    const channel = remoteFileChannelsRef.current.get(participantId)
    if (channel) {
      channel.close()
      dataChannelsRef.current.delete(channel)
    }
    remoteFileChannelsRef.current.delete(participantId)
    const channelId = remoteFileChannelIdsRef.current.get(participantId)
    if (channelId !== undefined) dataChannelIdsRef.current.delete(channelId)
    remoteFileChannelIdsRef.current.delete(participantId)
    incomingFilesRef.current.delete(participantId)

    remoteAudioStreamsRef.current
      .get(participantId)
      ?.getTracks()
      .forEach((track) => track.stop())
    remoteScreenStreamsRef.current
      .get(participantId)
      ?.getTracks()
      .forEach((track) => track.stop())
    remoteAudioStreamsRef.current.delete(participantId)
    remoteScreenStreamsRef.current.delete(participantId)
    if (pendingRemoteTrackRef.current?.peerId === participantId)
      pendingRemoteTrackRef.current = null
  }, [])

  const handleFileChannelMessage = useCallback(
    (channelKey: string, peerId: string, name: string, event: MessageEvent) => {
      if (typeof event.data === "string") {
        let message: {
          type?: string
          id?: string
          name?: string
          mime?: string
          size?: number
        }
        try {
          message = JSON.parse(event.data) as typeof message
        } catch {
          return
        }
        if (
          message.type === "file-start" &&
          message.id &&
          typeof message.name === "string" &&
          typeof message.mime === "string" &&
          typeof message.size === "number" &&
          message.size >= 0 &&
          message.size <= MAX_FILE_SIZE
        ) {
          incomingFilesRef.current.set(channelKey, {
            id: message.id,
            name: message.name.slice(0, 256),
            mime: message.mime.slice(0, 128),
            size: message.size,
            received: 0,
            chunks: [],
          })
          return
        }
        if (message.type === "file-end") {
          const transfer = incomingFilesRef.current.get(channelKey)
          if (!transfer || transfer.id !== message.id) return
          incomingFilesRef.current.delete(channelKey)
          if (transfer.received !== transfer.size) return
          addReceivedFileMessage(peerId, name, transfer, transfer.chunks)
        }
        return
      }

      const transfer = incomingFilesRef.current.get(channelKey)
      if (!transfer) return
      const consumeChunk = (chunk: ArrayBuffer) => {
        if (transfer.received + chunk.byteLength > transfer.size) {
          incomingFilesRef.current.delete(channelKey)
          return
        }
        transfer.chunks.push(chunk)
        transfer.received += chunk.byteLength
      }
      if (event.data instanceof ArrayBuffer) {
        consumeChunk(event.data)
      } else if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(consumeChunk)
      }
    },
    [addReceivedFileMessage]
  )

  const establishDataChannelTransport = useCallback(async () => {
    const pc = peerConnectionRef.current
    const session = sessionRef.current
    if (!pc || !session) throw new Error("SFU session is not ready")

    const serverEvents = pc.createDataChannel("server-events")
    dataChannelsRef.current.add(serverEvents)
    serverEvents.addEventListener("message", () => undefined)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const response = await apiRequest("datachannels/establish", {
      room: roomName,
      participantId: session.participantId,
      token: session.participantToken,
      sessionId: session.sessionId,
      dataChannel: {
        location: "remote",
        dataChannelName: "server-events",
      },
      sessionDescription: { type: offer.type, sdp: offer.sdp },
    })
    if (
      response.requiresImmediateRenegotiation &&
      response.sessionDescription
    ) {
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
    } else if (response.sessionDescription) {
      await pc.setRemoteDescription(response.sessionDescription)
    }

    const fileChannelName = `files-${session.participantId}`
    const channelResponse = await apiRequest("datachannels/new", {
      room: roomName,
      participantId: session.participantId,
      token: session.participantToken,
      sessionId: session.sessionId,
      dataChannels: [
        {
          location: "local",
          dataChannelName: fileChannelName,
          ordered: true,
        },
      ],
    })
    const channelId = channelResponse.dataChannels?.[0]?.id
    if (typeof channelId !== "number")
      throw new Error("SFU file data channel was not created")
    const channel = pc.createDataChannel(fileChannelName, {
      negotiated: true,
      id: channelId,
      ordered: true,
    })
    dataChannelsRef.current.add(channel)
    dataChannelIdsRef.current.add(channelId)
    channel.binaryType = "arraybuffer"
    channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_MARK
    localFileChannelRef.current = channel
    localFileChannelIdRef.current = channelId
    dataChannelReadyRef.current = true
  }, [apiRequest, roomName])

  const subscribeFileChannel = useCallback(
    async (participant: SfuParticipant) => {
      const pc = peerConnectionRef.current
      const session = sessionRef.current
      if (
        !pc ||
        !session ||
        participant.id === session.participantId ||
        !participant.media?.fileChannelReady ||
        remoteFileChannelsRef.current.has(participant.id)
      )
        return
      const media = participant.media
      const channelKey = participant.id
      const fileChannelName = `files-${participant.id}`
      const response = await apiRequest("datachannels/new", {
        room: roomName,
        participantId: session.participantId,
        token: session.participantToken,
        sessionId: session.sessionId,
        publisherSessionId: media.sessionId,
        dataChannels: [
          {
            location: "remote",
            sessionId: media.sessionId,
            dataChannelName: fileChannelName,
            ordered: true,
            waitForAck: true,
          },
        ],
      })
      const channelId = response.dataChannels?.[0]?.id
      if (typeof channelId !== "number")
        throw new Error("SFU remote file data channel was not created")
      const channel = pc.createDataChannel(`${fileChannelName}-subscriber`, {
        negotiated: true,
        id: channelId,
        ordered: true,
      })
      dataChannelsRef.current.add(channel)
      dataChannelIdsRef.current.add(channelId)
      channel.binaryType = "arraybuffer"
      channel.addEventListener("message", (event) =>
        handleFileChannelMessage(
          channelKey,
          participant.id,
          participant.name,
          event
        )
      )
      remoteFileChannelsRef.current.set(channelKey, channel)
      remoteFileChannelIdsRef.current.set(channelKey, channelId)
      await waitForDataChannelOpen(channel)
      channel.send("ack")
    },
    [apiRequest, handleFileChannelMessage, roomName, waitForDataChannelOpen]
  )

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
        localTrackMidsRef.current.set(trackName, transceiver.mid)
      })
    },
    [apiRequest, enqueueNegotiation, roomName]
  )

  const closePublishedTrack = useCallback(
    async (trackName: string) => {
      const pc = peerConnectionRef.current
      const session = sessionRef.current
      const mid = localTrackMidsRef.current.get(trackName)
      if (!pc || !session || !mid) return
      const transceiver = pc.getTransceivers().find((item) => item.mid === mid)
      if (transceiver) pc.removeTrack(transceiver.sender)
      try {
        await enqueueNegotiation(async () => {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          const response = await apiRequest("tracks/close", {
            room: roomName,
            participantId: session.participantId,
            token: session.participantToken,
            sessionId: session.sessionId,
            tracks: [{ mid, trackName }],
            sessionDescription: {
              type: offer.type,
              sdp: offer.sdp,
            },
            force: true,
          })
          if (response.sessionDescription)
            await pc.setRemoteDescription(response.sessionDescription)
        })
      } finally {
        localTrackMidsRef.current.delete(trackName)
      }
    },
    [apiRequest, enqueueNegotiation, roomName]
  )

  const subscribeTrack = useCallback(
    async (participant: SfuParticipant, track: SfuTrack) => {
      const session = sessionRef.current
      const pc = peerConnectionRef.current
      const media = participant.media
      if (!session || !pc || !media) return
      const key = `${participant.id}:${media.sessionId}:${track.trackName}`
      if (subscribedTracksRef.current.has(key)) return
      if (
        participantMapRef.current.get(participant.id)?.media?.sessionId !==
        media.sessionId
      )
        return
      subscribedTracksRef.current.add(key)
      await enqueueNegotiation(async () => {
        if (
          participantMapRef.current.get(participant.id)?.media?.sessionId !==
          media.sessionId
        )
          return
        pendingRemoteTrackRef.current = {
          peerId: participant.id,
          kind: track.kind,
          sessionId: media.sessionId,
        }
        const response = await apiRequest("tracks", {
          room: roomName,
          participantId: session.participantId,
          token: session.participantToken,
          sessionId: session.sessionId,
          tracks: [
            {
              location: "remote",
              sessionId: media.sessionId,
              trackName: track.trackName,
              kind: track.kind,
            },
          ],
        })
        if (!response.sessionDescription) {
          subscribedTracksRef.current.delete(key)
          console.warn(
            "sfu_remote_subscribe_missing_description",
            summarizeRemoteTrackResponse(response)
          )
          return
        }
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
      }).catch((error) => {
        subscribedTracksRef.current.delete(key)
        console.warn("sfu_remote_subscribe_failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        })
      })
    },
    [apiRequest, enqueueNegotiation, roomName]
  )

  const applyRoomState = useCallback(
    (state: SfuRoomState) => {
      roomStateRef.current = state
      setMeetingNotes(state.meetingNotes)
      setMeetingNotesMediaAvailable(state.meetingNotesMediaAvailable)
      setVoiceReply(state.voiceReply)
      setVoiceReplyMediaAvailable(state.voiceReplyMediaAvailable)
      for (const participant of state.participants) {
        const previous = participantMapRef.current.get(participant.id)
        if (
          previous?.media &&
          participant.media &&
          previous.media.sessionId !== participant.media.sessionId
        )
          resetRemoteParticipant(participant.id)
      }
      participantMapRef.current = new Map(
        state.participants.map((participant) => [
          participant.id,
          { ...participant, token: "" } as SfuParticipant,
        ])
      )
      const localParticipantId = sessionRef.current?.participantId
      replaceRoomMessages(
        state.messages.map((message) =>
          roomMessageToMessage(message, localParticipantId)
        )
      )
      rebuildParticipants()
      const localId = sessionRef.current?.participantId
      for (const participant of state.participants) {
        if (participant.id === localId) continue
        const fullParticipant = participantMapRef.current.get(participant.id)
        if (!fullParticipant) continue
        for (const track of participant.media?.tracks ?? []) {
          void subscribeTrack(fullParticipant, track)
        }
        if (fullParticipant.media?.fileChannelReady)
          void subscribeFileChannel(fullParticipant)
      }
    },
    [
      rebuildParticipants,
      resetRemoteParticipant,
      replaceRoomMessages,
      subscribeFileChannel,
      subscribeTrack,
    ]
  )

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    })
    peerConnectionRef.current = pc
    pc.ontrack = (event) => {
      const pending = pendingRemoteTrackRef.current
      if (!pending) return
      if (
        participantMapRef.current.get(pending.peerId)?.media?.sessionId !==
        pending.sessionId
      ) {
        pendingRemoteTrackRef.current = null
        return
      }
      const stream = event.streams[0] ?? new MediaStream([event.track])
      if (pending.kind === "video")
        remoteScreenStreamsRef.current.set(pending.peerId, stream)
      else remoteAudioStreamsRef.current.set(pending.peerId, stream)
      pendingRemoteTrackRef.current = null
      rebuildParticipants()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        mediaReconnectAttemptsRef.current = 0
        setConnectionStatus("connected")
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        void mediaReconnectRef.current?.()
      }
    }
    return pc
  }, [rebuildParticipants])

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
      if (dataChannelReadyRef.current)
        sendSocketMessage({ type: "datachannel-ready" })
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as SfuServerMessage
      if (message.type === "state" && message.state) {
        applyRoomState(message.state)
      } else if (
        message.type === "trackPublished" &&
        message.participant?.track
      ) {
        const participantId = message.participant.id
        const incomingSessionId = message.participant.sessionId
        if (!participantId) return
        const current = participantMapRef.current.get(participantId)
        if (
          current &&
          incomingSessionId &&
          current.media?.sessionId !== incomingSessionId
        ) {
          resetRemoteParticipant(participantId)
          if (current.media) {
            current.media = {
              ...current.media,
              sessionId: incomingSessionId,
              fileChannelReady: false,
              tracks: [message.participant.track],
            }
          } else {
            // Human resync missed the agent-media-attach state broadcast;
            // bootstrap from the publication so subscribe can proceed.
            current.media = {
              sessionId: incomingSessionId,
              muted: false,
              fileChannelReady: false,
              tracks: [message.participant.track],
            }
          }
        } else if (current) {
          if (!current.media) {
            if (!incomingSessionId) return
            current.media = {
              sessionId: incomingSessionId,
              muted: false,
              fileChannelReady: false,
              tracks: [message.participant.track],
            }
          } else {
            current.media.tracks = [
              ...current.media.tracks.filter(
                (track) =>
                  track.trackName !== message.participant!.track!.trackName
              ),
              message.participant.track,
            ]
          }
        } else if (message.participant.name && incomingSessionId) {
          participantMapRef.current.set(participantId, {
            id: participantId,
            name: message.participant.name,
            kind: message.participant.kind ?? "human",
            connected: true,
            media: {
              sessionId: incomingSessionId,
              muted: false,
              fileChannelReady: false,
              tracks: [message.participant.track],
            },
            joinedAt: Date.now(),
            lastSeenAt: Date.now(),
            token: "",
          })
        }
        const participant = participantMapRef.current.get(participantId)
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
        if (
          participant?.media &&
          typeof message.participant.muted === "boolean"
        ) {
          participant.media.muted = message.participant.muted
          rebuildParticipants()
        }
        if (
          participant?.media &&
          message.participant.fileChannelReady === true
        ) {
          participant.media.fileChannelReady = true
          void subscribeFileChannel(participant)
          rebuildParticipants()
        }
      } else if (message.type === "message" && message.message) {
        const localParticipantId = sessionRef.current?.participantId
        appendRoomMessage(
          roomMessageToMessage(message.message, localParticipantId)
        )
      } else if (message.type === "expired") {
        setError(
          "This room has closed after being empty for a while. Please open a new room."
        )
        setConnectionStatus("failed")
      } else if (message.type === "error") {
        setError(message.error || "SFU room error")
      }
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (closingRef.current) return
      if (socket !== websocketRef.current) return
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
  }, [
    appendRoomMessage,
    applyRoomState,
    rebuildParticipants,
    resetRemoteParticipant,
    sendSocketMessage,
    subscribeFileChannel,
    subscribeTrack,
  ])

  const connectMediaSession = useCallback(
    async (reconnecting: boolean) => {
      const previousSession = sessionRef.current
      if (reconnecting && !previousSession)
        throw new Error("SFU session is not ready")

      if (reconnecting) {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
        const oldSocket = websocketRef.current
        if (oldSocket) {
          oldSocket.onclose = null
          oldSocket.onerror = null
          oldSocket.close()
          websocketRef.current = null
        }
        await closeDataChannels(previousSession)
        for (const channel of dataChannelsRef.current) channel.close()
        dataChannelsRef.current.clear()
        for (const channel of remoteFileChannelsRef.current.values())
          channel.close()
        remoteFileChannelsRef.current.clear()
        remoteFileChannelIdsRef.current.clear()
        peerConnectionRef.current?.close()
        peerConnectionRef.current = null
        dataChannelReadyRef.current = false
        localTrackMidsRef.current.clear()
        subscribedTracksRef.current.clear()
        remoteAudioStreamsRef.current.clear()
        remoteScreenStreamsRef.current.clear()
        pendingRemoteTrackRef.current = null
      }

      // A fresh Human session must be Turnstile-verified; reconnects prove
      // authorization with the previous participant/session id instead and
      // never need — or trigger — a new challenge.
      let turnstileToken: string | undefined
      if (!reconnecting && getTurnstileToken) {
        setConnectionStatus("verifying")
        try {
          turnstileToken = await getTurnstileToken()
        } catch (err) {
          throw new TurnstileVerificationError(
            err instanceof Error ? err.message : "Verification failed"
          )
        }
      }
      setConnectionStatus(reconnecting ? "reconnecting" : "connecting")

      let audioTrack = localAudioTrackRef.current
      if (!audioTrack) {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        })
        audioTrack = media.getAudioTracks()[0] ?? null
        if (!audioTrack) throw new Error("No microphone track available")
        localAudioTrackRef.current = audioTrack
      }

      const pc = createPeerConnection()
      pc.addTrack(audioTrack, new MediaStream([audioTrack]))
      const screenTrack = localScreenTrackRef.current
      if (screenTrack && screenTrack.readyState === "live")
        pc.addTrack(screenTrack, new MediaStream([screenTrack]))
      rebuildParticipants()

      const body: Record<string, unknown> = {
        room: roomName,
        name: nickName,
        kind: "human",
        turnstileToken,
      }
      if (reconnecting && previousSession) {
        body.reconnect = {
          participantId: previousSession.participantId,
          participantToken: previousSession.participantToken,
          sessionId: previousSession.sessionId,
        }
      }
      const response = await fetch("/api/sfu/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        if (!reconnecting && response.status === 403) {
          throw new TurnstileVerificationError(
            data.error || "Verification failed"
          )
        }
        throw new Error(data.error || "Unable to create SFU session")
      }
      const session = (await response.json()) as SfuSessionResponse
      sessionRef.current = { ...session, room: roomName }
      await establishDataChannelTransport()
      await publishTrack(audioTrack, "audio", `audio-${session.participantId}`)
      if (screenTrack && screenTrack.readyState === "live") {
        await publishTrack(
          screenTrack,
          "video",
          localScreenTrackNameRef.current
        )
      }
      connectWebSocket()
    },
    [
      closeDataChannels,
      connectWebSocket,
      createPeerConnection,
      establishDataChannelTransport,
      getTurnstileToken,
      nickName,
      publishTrack,
      rebuildParticipants,
      roomName,
    ]
  )

  const reconnectMedia = useCallback(async () => {
    if (closingRef.current || mediaReconnectPromiseRef.current) return
    const attempt = mediaReconnectAttemptsRef.current++
    if (attempt >= 5) {
      setError("SFU media connection lost. Reload to start a new session.")
      setConnectionStatus("failed")
      return
    }
    const promise = (async () => {
      setConnectionStatus("reconnecting")
      try {
        await connectMediaSession(true)
        mediaReconnectAttemptsRef.current = 0
        setError("")
      } catch (err) {
        if (attempt >= 4) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to reconnect to SFU media"
          )
          setConnectionStatus("failed")
          return
        }
        mediaReconnectTimerRef.current = setTimeout(() => {
          void mediaReconnectRef.current?.()
        }, Math.min(1000 * 2 ** attempt, 8000))
      }
    })()
    mediaReconnectPromiseRef.current = promise
    try {
      await promise
    } finally {
      mediaReconnectPromiseRef.current = null
    }
  }, [connectMediaSession])

  useEffect(() => {
    if (!enabled || !roomName || !nickName) return
    closingRef.current = false
    const start = async () => {
      try {
        await connectMediaSession(false)
      } catch (err) {
        if (err instanceof TurnstileVerificationError) {
          setError(err.message)
          setConnectionStatus("verification_failed")
          return
        }
        setError(
          err instanceof Error ? err.message : "Unable to connect to SFU"
        )
        setConnectionStatus("failed")
      }
    }
    mediaReconnectRef.current = reconnectMedia
    initialConnectRef.current = start
    void start()

    const remoteFileChannels = remoteFileChannelsRef.current
    const remoteFileChannelIds = remoteFileChannelIdsRef.current
    const incomingFiles = incomingFilesRef.current
    const objectUrls = objectUrlsRef.current
    const dataChannels = dataChannelsRef.current
    const localTrackMids = localTrackMidsRef.current

    return () => {
      closingRef.current = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (mediaReconnectTimerRef.current)
        clearTimeout(mediaReconnectTimerRef.current)
      void closeDataChannels(sessionRef.current)
      sendSocketMessage({ type: "leave" })
      websocketRef.current?.close()
      localAudioTrackRef.current?.stop()
      localScreenTrackRef.current?.stop()
      localFileChannelRef.current?.close()
      localFileChannelRef.current = null
      for (const channel of dataChannels) channel.close()
      dataChannels.clear()
      for (const channel of remoteFileChannels.values()) channel.close()
      remoteFileChannels.clear()
      remoteFileChannelIds.clear()
      localFileChannelIdRef.current = null
      incomingFiles.clear()
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.clear()
      roomMessagesRef.current = []
      ephemeralMessagesRef.current = []
      dataChannelReadyRef.current = false
      localTrackMids.clear()
      mediaReconnectRef.current = null
      initialConnectRef.current = null
      peerConnectionRef.current?.close()
      peerConnectionRef.current = null
    }
  }, [
    closeDataChannels,
    connectMediaSession,
    enabled,
    nickName,
    reconnectMedia,
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
      const track = localScreenTrackRef.current
      track.onended = null
      try {
        await closePublishedTrack(trackName)
      } catch {
        sendSocketMessage({ type: "unpublish", trackName })
      }
      track.stop()
      localScreenTrackRef.current = null
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
          void closePublishedTrack(localScreenTrackNameRef.current)
            .catch(() => {
              sendSocketMessage({
                type: "unpublish",
                trackName: localScreenTrackNameRef.current,
              })
            })
            .finally(() => {
              localScreenTrackRef.current = null
              rebuildParticipants()
            })
        }
      }
      rebuildParticipants()
      await publishTrack(track, "video", localScreenTrackNameRef.current)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Screen sharing was not started"
      )
    }
  }, [
    closePublishedTrack,
    publishTrack,
    rebuildParticipants,
    sendSocketMessage,
  ])

  const sendTextMessage = useCallback(
    (text: string, targets: string[] = []) => {
      sendSocketMessage({ type: "chat", text, targets })
    },
    [sendSocketMessage]
  )

  const sendActionMessage = useCallback(
    (actionType: ActionType, actionPayload: Record<string, string>) => {
      sendSocketMessage({ type: "action", actionType, actionPayload })
    },
    [sendSocketMessage]
  )

  // #117: authenticated Human on-demand read of one existing room
  // collaboration artifact. Credentials ride in request headers only; the
  // response is validated strictly (id match, MIME allow-list, size bounds,
  // exact base64 length) before it can reach any UI. Nothing is cached here.
  const readRoomAttachment = useCallback(
    async (attachmentId: string): Promise<RoomAttachmentRead> => {
      if (!attachmentId) throw new Error("attachmentId is required")
      const session = sessionRef.current
      if (!session) throw new Error("Not connected to the room")
      const response = await fetch("/api/room/attachments/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Room-Id": session.room,
          "X-Room-Participant-Id": session.participantId,
          "X-Room-Participant-Token": session.participantToken,
        },
        body: JSON.stringify({ attachmentId }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: unknown
        }
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `attachment_read_failed_${response.status}`
        )
      }
      const payload = (await response.json().catch(() => null)) as unknown
      const validated = validateRoomAttachmentRead(payload, attachmentId)
      if (validated.ok === false)
        throw new Error(`invalid_attachment_payload: ${validated.error}`)
      return validated.read
    },
    []
  )

  // #115: Human accepted/declined for an Agent-originated request addressed
  // to this participant. Returns false when the socket is closed or inputs
  // are invalid — never claims success without sending. The canonical state
  // arrives via the ordinary broadcast (no optimistic echo).
  const sendCollabResponse = useCallback(
    (
      requestId: string,
      decision: "accepted" | "declined",
      summary?: string
    ): boolean => {
      if (!requestId) return false
      if (websocketRef.current?.readyState !== WebSocket.OPEN) return false
      const trimmed = summary?.trim()
      sendSocketMessage({
        type: "collab-response",
        requestId,
        decision,
        ...(trimmed
          ? { summary: trimmed.slice(0, MAX_COLLAB_SUMMARY_LENGTH) }
          : {}),
      })
      return true
    },
    [sendSocketMessage]
  )

  // #121: Human terminal result (completed | failed) for an
  // Agent-originated request this Human accepted. Returns false when the
  // socket is closed or inputs are invalid — never claims success without
  // sending. Canonical state arrives via the ordinary broadcast.
  const sendCollabResult = useCallback(
    (
      requestId: string,
      status: "completed" | "failed",
      summary: string
    ): boolean => {
      if (!requestId) return false
      if (status !== "completed" && status !== "failed") return false
      const trimmed = summary.trim()
      if (!trimmed || trimmed.length > MAX_COLLAB_SUMMARY_LENGTH) return false
      if (websocketRef.current?.readyState !== WebSocket.OPEN) return false
      sendSocketMessage({
        type: "collab-result",
        requestId,
        status,
        summary: trimmed,
      })
      return true
    },
    [sendSocketMessage]
  )

  // #119: replace THIS Human's advertised capability list (discovery
  // metadata only). Local guard uses the same shared validator as the
  // server; the authoritative list comes back via Room state broadcast.
  // Returns true when the envelope was sent.
  const updateHumanCapabilities = useCallback(
    (capabilities: string[]): boolean => {
      if (websocketRef.current?.readyState !== WebSocket.OPEN) return false
      const validated = validateAdvertisedCapabilities(capabilities)
      if (!validated.ok) return false
      sendSocketMessage({
        type: "human-update-capabilities",
        capabilities: validated.capabilities,
      })
      return true
    },
    [sendSocketMessage]
  )

  // #113: Human-originated structured work request to a connected Agent.
  // Returns the generated requestId (empty string when rejected locally).
  // The canonical RoomMessage arrives via the ordinary broadcast — no
  // optimistic echo here.
  const sendCollabRequest = useCallback(
    (
      targetParticipantId: string,
      summary: string,
      attachmentIds?: string[]
    ): string => {
      const trimmed = summary.trim()
      if (
        !targetParticipantId ||
        !trimmed ||
        trimmed.length > MAX_COLLAB_SUMMARY_LENGTH
      )
        return ""
      // Local guard: attachmentIds must be absent or a non-empty array of at
      // most MAX_COLLAB_ATTACHMENT_REFS non-empty bounded strings with no
      // duplicates. The server remains authoritative.
      if (attachmentIds !== undefined) {
        const ids = attachmentIds
        if (!Array.isArray(ids)) return ""
        for (const id of ids)
          if (typeof id !== "string" || id.length === 0 || id.length > 64)
            return ""
        if (new Set(ids).size !== ids.length) return ""
        if (ids.length > MAX_COLLAB_ATTACHMENT_REFS) return ""
      }
      if (websocketRef.current?.readyState !== WebSocket.OPEN) return ""
      const requestId = crypto.randomUUID()
      sendSocketMessage({
        type: "collab-request",
        requestId,
        targetParticipantId,
        summary: trimmed,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      })
      return requestId
    },
    [sendSocketMessage]
  )

  // #123: upload one file as an ephemeral Room artifact for collab context.
  // Returns safe public metadata including the attachmentId needed to
  // reference it in a collab request.
  const uploadRoomAttachment = useCallback(
    async (
      file: File
    ): Promise<{
      id: string
      fileName: string
      mimeType: string
      size: number
    }> => {
      const session = sessionRef.current
      if (!session) throw new Error("Not connected to the room")
      const response = await fetch("/api/room/attachments", {
        method: "POST",
        headers: {
          "Content-Type":
            agentTextMime(file) ?? (file.type || "application/octet-stream"),
          "X-Room-Id": session.room,
          "X-Room-Participant-Id": session.participantId,
          "X-Room-Participant-Token": session.participantToken,
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: unknown
        }
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `attachment_upload_failed_${response.status}`
        )
      }
      // Upload responses are UNTRUSTED here too: metadata is re-checked
      // against the shared limits before its id may be referenced.
      const uploaded = validateUploadedRoomAttachment(
        await response.json().catch(() => null)
      )
      if (!uploaded) throw new Error("invalid_attachment_payload")
      return uploaded
    },
    []
  )

  const startMeetingNotes = useCallback(
    (agentParticipantId: string) => {
      sendSocketMessage({
        type: "meeting-notes-start",
        agentParticipantId,
      })
    },
    [sendSocketMessage]
  )

  const stopMeetingNotes = useCallback(() => {
    sendSocketMessage({ type: "meeting-notes-stop" })
  }, [sendSocketMessage])

  // #83: Human grant for exactly one connected resident Agent's outbound
  // voice; server re-checks sender/target on every control message.
  const startVoiceReply = useCallback(
    (agentParticipantId: string) => {
      sendSocketMessage({
        type: "voice-reply-start",
        agentParticipantId,
      })
    },
    [sendSocketMessage]
  )

  const stopVoiceReply = useCallback(() => {
    sendSocketMessage({ type: "voice-reply-stop" })
  }, [sendSocketMessage])

  const sendFileMessage = useCallback(
    async (file: File) => {
      const send = async () => {
        if (file.size > MAX_FILE_SIZE)
          throw new Error("File exceeds the 20 MB limit")
        const channel = localFileChannelRef.current
        if (!channel) throw new Error("SFU file data channel is unavailable")
        await waitForDataChannelOpen(channel)
        const id = crypto.randomUUID()
        const mime = file.type || "application/octet-stream"
        channel.send(
          JSON.stringify({
            type: "file-start",
            id,
            name: file.name,
            mime,
            size: file.size,
          })
        )
        for (let offset = 0; offset < file.size; offset += FILE_CHUNK_SIZE) {
          await waitForSendCapacity(channel)
          const chunk = await file
            .slice(offset, offset + FILE_CHUNK_SIZE)
            .arrayBuffer()
          channel.send(chunk)
        }
        await waitForSendCapacity(channel)
        channel.send(JSON.stringify({ type: "file-end", id }))
        const fileLink = URL.createObjectURL(file)
        objectUrlsRef.current.add(fileLink)
        appendEphemeralMessage({
          peerId: LOCAL_PEER_ID,
          name: nickName,
          type: mime.startsWith("image/") ? "image" : "file",
          messageId: id,
          createdAt: Date.now(),
          fileLink,
          fileName: file.name,
          fileSize: file.size,
        })
        const session = sessionRef.current
        const hasConnectedAgent = [...participantMapRef.current.values()].some(
          (participant) => participant.kind === "agent" && participant.connected
        )
        if (
          session &&
          hasConnectedAgent &&
          (isAgentImage(file) || isAgentTextFile(file))
        ) {
          void (async () => {
            try {
              let uploadType = file.type
              let uploadBody: ArrayBuffer | Blob = file
              if (isAgentImage(file)) {
                const visionCopy = await createAgentVisionCopy(file)
                uploadType = visionCopy.type || file.type
                uploadBody = await visionCopy.arrayBuffer()
              } else {
                uploadType = agentTextMime(file) ?? file.type
              }
              await fetch("/api/room/attachments", {
                method: "POST",
                headers: {
                  "Content-Type": uploadType,
                  "X-Room-Id": roomName,
                  "X-Room-Participant-Id": session.participantId,
                  "X-Room-Participant-Token": session.participantToken,
                  "X-File-Name": encodeURIComponent(file.name.slice(0, 256)),
                },
                body: uploadBody,
              })
            } catch {
              // Agent vision is secondary; human DataChannel delivery already succeeded.
            }
          })()
        }
      }
      const next = fileSendQueueRef.current.then(send, send)
      fileSendQueueRef.current = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
    [
      appendEphemeralMessage,
      nickName,
      roomName,
      waitForDataChannelOpen,
      waitForSendCapacity,
    ]
  )

  const retryVerification = useCallback(() => {
    if (closingRef.current) return
    setError("")
    void initialConnectRef.current?.()
  }, [])

  // #111: credentials for the LOCAL participant, used to authenticate
  // on-demand workspace-snapshot reads. Never leaves the client except in
  // request headers to this room's own Worker/DO.
  const getLocalRoomAuth = useCallback(() => {
    const session = sessionRef.current
    if (!session) return null
    return {
      roomId: session.room,
      participantId: session.participantId,
      token: session.participantToken,
    }
  }, [])

  return {
    participants,
    getLocalRoomAuth,
    messages,
    sendTextMessage,
    sendFileMessage,
    sendActionMessage,
    sendCollabRequest,
    uploadRoomAttachment,
    sendCollabResponse,
    sendCollabResult,
    updateHumanCapabilities,
    readRoomAttachment,
    localParticipantId: sessionRef.current?.participantId,
    muteSelf,
    toggleScreenShare,
    retryVerification,
    error,
    connectionStatus,
    resolvedRoomType,
    meetingNotes,
    meetingNotesMediaAvailable,
    startMeetingNotes,
    stopMeetingNotes,
    voiceReply,
    voiceReplyMediaAvailable,
    startVoiceReply,
    stopVoiceReply,
  }
}
