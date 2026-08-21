import { DurableObject } from "cloudflare:workers"

import type {
  SfuMessage,
  SfuParticipant,
  SfuRoomRecord,
  SfuRoomState,
  SfuTrack,
} from "../sfu/types"

const ROOM_MAX_AGE_MS = 2 * 60 * 60 * 1000
const RECONNECT_GRACE_MS = 30 * 1000
const MAX_MESSAGES = 100

export interface RoomSessionEnv {
  SFU_ROOM: DurableObjectNamespace<RoomSession>
}

interface ConnectionAttachment {
  participantId: string
  token: string
  connectionNonce: string
}

type ControlRequest =
  | {
      action: "register"
      participant: Omit<SfuParticipant, "connected" | "lastSeenAt">
    }
  | {
      action: "authorize"
      participantId: string
      token: string
      sessionId?: string
      trackSessionId?: string
      trackName?: string
      dataChannelSessionId?: string
    }
  | {
      action: "reconnect"
      participantId: string
      token: string
      sessionId: string
      newSessionId: string
    }
  | {
      action: "publish"
      participantId: string
      token: string
      track: SfuTrack
    }
  | {
      action: "unpublish"
      participantId: string
      token: string
      trackName: string
    }
  | {
      action: "leave"
      participantId: string
      token: string
    }

type ClientMessage =
  | { type: "chat"; text: string }
  | {
      type: "action"
      actionType: string
      actionPayload?: Record<string, string>
    }
  | { type: "mute"; muted: boolean }
  | { type: "unpublish"; trackName: string }
  | { type: "datachannel-ready" }
  | { type: "resync" }
  | { type: "leave" }

export class RoomSession extends DurableObject<RoomSessionEnv> {
  private async loadRoom(): Promise<SfuRoomRecord | null> {
    return this.ctx.storage.get<SfuRoomRecord>("room")
  }

  private async saveRoom(room: SfuRoomRecord): Promise<void> {
    await this.ctx.storage.put("room", room)
  }

  private stateFor(room: SfuRoomRecord): SfuRoomState {
    return {
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participants: Object.values(room.participants)
        .filter((participant) => participant.connected)
        .map(
          ({ token: _token, connectionNonce: _nonce, ...participant }) =>
            participant
        ),
      messages: room.messages,
    }
  }

  private json(data: unknown, status = 200): Response {
    return Response.json(data, { status })
  }

  private isExpired(room: SfuRoomRecord): boolean {
    return Date.now() >= room.expiresAt
  }

  private async activeRoom(): Promise<SfuRoomRecord | null> {
    const room = await this.loadRoom()
    if (!room) return null
    if (this.isExpired(room)) {
      await this.expireRoom(room)
      return null
    }
    return room
  }

  private async expireRoom(room: SfuRoomRecord): Promise<void> {
    await this.ctx.storage.delete("room")
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "expired" }))
        socket.close(4001, "Room expired")
      } catch {
        // A socket may already be closed while the room is expiring.
      }
    }
  }

  private async broadcast(message: unknown, except?: WebSocket): Promise<void> {
    const encoded = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue
      try {
        socket.send(encoded)
      } catch {
        socket.close(1011, "Broadcast failed")
      }
    }
  }

  private async broadcastState(
    room?: SfuRoomRecord,
    except?: WebSocket
  ): Promise<void> {
    const current = room ?? (await this.activeRoom())
    if (current) {
      await this.broadcast(
        { type: "state", state: this.stateFor(current) },
        except
      )
    }
  }

  private findParticipant(
    room: SfuRoomRecord,
    participantId: string,
    token: string,
    sessionId?: string
  ): SfuParticipant | null {
    const participant = room.participants[participantId]
    if (!participant || participant.token !== token) return null
    if (sessionId && participant.sessionId !== sessionId) return null
    return participant
  }

  private async handleControl(request: ControlRequest): Promise<Response> {
    if (request.action === "register") {
      const now = Date.now()
      let room = await this.loadRoom()
      if (room && this.isExpired(room)) {
        await this.expireRoom(room)
        return this.json({ error: "room_expired" }, 410)
      }
      if (!room) {
        room = {
          createdAt: now,
          expiresAt: now + ROOM_MAX_AGE_MS,
          participants: {},
          messages: [],
        }
      }
      const participant: SfuParticipant = {
        ...request.participant,
        connected: false,
        lastSeenAt: now,
        tracks: request.participant.tracks ?? [],
        fileChannelReady: false,
      }
      room.participants[participant.id] = participant
      await this.saveRoom(room)
      await this.ctx.storage.setAlarm(
        Math.min(room.expiresAt, now + RECONNECT_GRACE_MS)
      )
      return this.json({
        state: this.stateFor(room),
        expiresAt: room.expiresAt,
      })
    }

    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)

    if (request.action === "authorize") {
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (request.trackSessionId && request.trackName) {
        const trackExists = Object.values(room.participants).some(
          (candidate) =>
            candidate.sessionId === request.trackSessionId &&
            candidate.tracks.some(
              (track) => track.trackName === request.trackName
            )
        )
        if (!trackExists) return this.json({ error: "track_not_found" }, 404)
      }
      if (request.dataChannelSessionId) {
        const sessionExists = Object.values(room.participants).some(
          (candidate) =>
            candidate.sessionId === request.dataChannelSessionId &&
            candidate.connected
        )
        if (!sessionExists)
          return this.json({ error: "datachannel_session_not_found" }, 404)
      }
      return this.json({ ok: true })
    }

    if (request.action === "reconnect") {
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      participant.sessionId = request.newSessionId
      participant.connected = false
      participant.connectionNonce = undefined
      participant.fileChannelReady = false
      participant.tracks = []
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      return this.json({
        ok: true,
        expiresAt: room.expiresAt,
      })
    }

    const participant = this.findParticipant(
      room,
      request.participantId,
      request.token
    )
    if (!participant) return this.json({ error: "unauthorized" }, 401)

    if (request.action === "publish") {
      participant.tracks = [
        ...participant.tracks.filter(
          (track) => track.trackName !== request.track.trackName
        ),
        request.track,
      ]
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.broadcast({
        type: "trackPublished",
        participant: {
          id: participant.id,
          name: participant.name,
          kind: participant.kind,
          sessionId: participant.sessionId,
          track: request.track,
        },
      })
      return this.json({ ok: true })
    }

    if (request.action === "unpublish") {
      participant.tracks = participant.tracks.filter(
        (track) => track.trackName !== request.trackName
      )
      await this.saveRoom(room)
      await this.broadcastState(room)
      return this.json({ ok: true })
    }

    delete room.participants[participant.id]
    await this.saveRoom(room)
    await this.broadcastState(room)
    return this.json({ ok: true })
  }

  private async handleClientMessage(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    message: ClientMessage
  ): Promise<void> {
    const room = await this.activeRoom()
    if (!room) {
      socket.send(JSON.stringify({ type: "expired" }))
      socket.close(4001, "Room expired")
      return
    }
    const participant = this.findParticipant(
      room,
      attachment.participantId,
      attachment.token
    )
    if (!participant) {
      socket.close(4003, "Unauthorized")
      return
    }
    participant.lastSeenAt = Date.now()

    if (message.type === "resync") {
      socket.send(JSON.stringify({ type: "state", state: this.stateFor(room) }))
      return
    }
    if (message.type === "leave") {
      delete room.participants[participant.id]
      await this.saveRoom(room)
      await this.broadcastState(room)
      socket.close(1000, "Left room")
      return
    }
    if (message.type === "mute") {
      participant.muted = message.muted
      await this.saveRoom(room)
      await this.broadcast({
        type: "participantUpdated",
        participant: {
          id: participant.id,
          muted: participant.muted,
        },
      })
      return
    }
    if (message.type === "unpublish") {
      participant.tracks = participant.tracks.filter(
        (track) => track.trackName !== message.trackName
      )
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "datachannel-ready") {
      participant.fileChannelReady = true
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }

    if (message.type === "chat" && message.text.trim()) {
      const roomMessage: SfuMessage = {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "text",
        text: message.text.slice(0, 4000),
        createdAt: Date.now(),
      }
      room.messages = [...room.messages, roomMessage].slice(-MAX_MESSAGES)
      await this.saveRoom(room)
      await this.broadcast({ type: "message", message: roomMessage })
      return
    }

    if (message.type === "action") {
      const roomMessage: SfuMessage = {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "action",
        actionType: message.actionType,
        actionPayload: message.actionPayload,
        createdAt: Date.now(),
      }
      room.messages = [...room.messages, roomMessage].slice(-MAX_MESSAGES)
      await this.saveRoom(room)
      await this.broadcast({ type: "message", message: roomMessage })
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (request.method !== "GET")
        return this.json({ error: "method_not_allowed" }, 405)
      const participantId = url.searchParams.get("participantId")
      const token = url.searchParams.get("token")
      if (!participantId || !token)
        return this.json({ error: "unauthorized" }, 401)
      const room = await this.activeRoom()
      const participant =
        room && this.findParticipant(room, participantId, token)
      if (!room || !participant)
        return this.json({ error: "unauthorized" }, 401)

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
      const connectionNonce = crypto.randomUUID()
      participant.connected = true
      participant.connectionNonce = connectionNonce
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ participantId, token, connectionNonce })
      server.send(JSON.stringify({ type: "state", state: this.stateFor(room) }))
      await this.broadcastState(room, server)
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method !== "POST" || url.pathname !== "/control") {
      return this.json({ error: "not_found" }, 404)
    }
    try {
      return await this.handleControl((await request.json()) as ControlRequest)
    } catch {
      return this.json({ error: "invalid_request" }, 400)
    }
  }

  async webSocketMessage(
    socket: WebSocket,
    raw: string | ArrayBuffer
  ): Promise<void> {
    if (typeof raw !== "string") return
    const attachment =
      socket.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) return socket.close(4003, "Missing connection state")
    try {
      await this.handleClientMessage(
        socket,
        attachment,
        JSON.parse(raw) as ClientMessage
      )
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid_message" }))
    }
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const attachment =
      socket.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) return
    const room = await this.activeRoom()
    if (!room) return
    const participant = room.participants[attachment.participantId]
    if (
      !participant ||
      participant.connectionNonce !== attachment.connectionNonce
    )
      return
    participant.connected = false
    participant.lastSeenAt = Date.now()
    participant.connectionNonce = undefined
    await this.saveRoom(room)
    await this.ctx.storage.setAlarm(
      Math.min(room.expiresAt, Date.now() + RECONNECT_GRACE_MS)
    )
    await this.broadcastState(room)
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011, "WebSocket error", false)
  }

  async alarm(): Promise<void> {
    const room = await this.loadRoom()
    if (!room) return
    const now = Date.now()
    if (now >= room.expiresAt) {
      await this.expireRoom(room)
      return
    }
    for (const [id, participant] of Object.entries(room.participants)) {
      if (
        !participant.connected &&
        participant.lastSeenAt + RECONNECT_GRACE_MS <= now
      ) {
        delete room.participants[id]
      }
    }
    await this.saveRoom(room)
    await this.broadcastState(room)
    const nextStale = Object.values(room.participants)
      .filter((participant) => !participant.connected)
      .map((participant) => participant.lastSeenAt + RECONNECT_GRACE_MS)
      .sort((a, b) => a - b)[0]
    if (nextStale)
      await this.ctx.storage.setAlarm(Math.min(room.expiresAt, nextStale))
    else await this.ctx.storage.setAlarm(room.expiresAt)
  }
}
