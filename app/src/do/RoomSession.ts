import { DurableObject } from "cloudflare:workers"

import {
  clearGrantIfParticipantDeparting,
  isAgentAuthorizedForMedia,
  NO_MEETING_NOTES,
  startMeetingNotes,
} from "./meetingNotesAuth"
import { closeRealtimeTracks } from "./realtimeMedia"
import { computeExpiresAt, NO_EXPIRY } from "./roomExpiry"
import type {
  AgentEvent,
  RoomCapabilities,
  RoomAttachment,
  AgentImageMimeType,
  MeetingNotesState,
  RoomMediaTrack,
  RoomMessage,
  RoomParticipant,
  RoomRecord,
  RoomState,
} from "../room/types"

const RECONNECT_GRACE_MS = 30 * 1000
const AGENT_LEASE_MS = 90 * 1000
const MAX_MESSAGES = 100
const MAX_AGENT_ATTACHMENTS = 8
const MAX_AGENT_IMAGE_BYTES = 768 * 1024
const ATTACHMENT_CHUNK_SIZE = 64 * 1024
const MAX_TARGETS = 8
// Bounded per-agent scratch state for server-side revocation (finding #3):
// one mid per Human audio track the note-taker Agent is currently
// subscribed to. Not a general media-session database — cleared to empty
// on every revocation (Stop, reassignment, leave, lease expiry) and never
// grows past a small, room-sized cap.
const MAX_AGENT_SUBSCRIBED_MIDS = 64

const ROOM_CAPABILITIES: RoomCapabilities = {
  text: true,
  audio: true,
  screenShare: true,
  files: true,
  agentText: true,
  agentImages: true,
  agentTargeting: true,
}

export interface RoomSessionEnv {
  SFU_ROOM: DurableObjectNamespace<RoomSession>
  // RoomSession is bound within the same Worker as sfu/server.ts (see
  // wrangler.jsonc), so its runtime `env` is already the full Worker env —
  // these three are declared here only to widen the *type*, not because any
  // new binding/secret needs to be added. SFU_APP_ID/SFU_APP_SECRET are used
  // to actively close Cloudflare Realtime tracks on Meeting Notes
  // revocation (see realtimeMedia.ts); AGENT_MEDIA_ENABLED gates the
  // "meeting-notes-start" WS message the same way it already gates
  // agent-session/agent-room-media in sfu/server.ts, so the room-visible
  // grant can never claim "active" in an environment where every actual
  // Runtime media request would 403.
  SFU_APP_ID?: string
  SFU_APP_SECRET?: string
  AGENT_MEDIA_ENABLED?: string
}

interface ConnectionAttachment {
  participantId: string
  token: string
  connectionNonce: string
}

interface StoredParticipant extends RoomParticipant {
  sessionId?: string
  muted?: boolean
  fileChannelReady?: boolean
  tracks?: RoomMediaTrack[]
}

interface StoredRoom
  extends Omit<
    RoomRecord,
    | "participants"
    | "messages"
    | "attachments"
    | "nextMessageSequence"
    | "meetingNotes"
  > {
  participants: Record<string, StoredParticipant>
  messages: Array<Omit<RoomMessage, "sequence"> & { sequence?: number }>
  attachments?: RoomAttachment[]
  nextMessageSequence?: number
  meetingNotes?: MeetingNotesState
}

interface AgentWaiter {
  participantId: string
  cursor: number
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
}

type ControlRequest =
  | {
      action: "register"
      participant: Omit<RoomParticipant, "connected" | "lastSeenAt">
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
      track: RoomMediaTrack
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
  | { action: "room-info" }
  | {
      action: "agent-register"
      participant: Omit<RoomParticipant, "connected" | "lastSeenAt">
    }
  | {
      action: "agent-wait"
      participantId: string
      token: string
      cursor: number
      timeoutSeconds: number
    }
  | {
      action: "agent-send-text"
      participantId: string
      token: string
      text: string
    }
  | {
      action: "agent-read-attachment"
      participantId: string
      token: string
      attachmentId: string
    }
  | {
      action: "agent-leave"
      participantId: string
      token: string
    }
  | {
      action: "agent-media-attach"
      participantId: string
      token: string
      sessionId: string
    }
  | {
      action: "agent-room-media"
      participantId: string
      token: string
    }
  | {
      action: "agent-track-subscribed"
      participantId: string
      token: string
      sessionId: string
      mids: string[]
    }

type ClientMessage =
  | { type: "chat"; text: string; targets?: string[] }
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
  | { type: "meeting-notes-start"; agentParticipantId: string }
  | { type: "meeting-notes-stop" }

export class RoomSession extends DurableObject<RoomSessionEnv> {
  // A participant has at most one outstanding long-poll. A null value is a
  // short-lived reservation while the request refreshes its lease.
  private readonly agentWaiters = new Map<string, AgentWaiter | null>()

  private async loadRoom(): Promise<RoomRecord | null> {
    const stored = await this.ctx.storage.get<StoredRoom>("room")
    if (!stored) return null
    const normalized = this.normalizeRoom(stored)
    if (normalized.changed) await this.saveRoom(normalized.room)
    return normalized.room
  }

  private normalizeRoom(stored: StoredRoom): {
    room: RoomRecord
    changed: boolean
  } {
    let changed = false
    const participants: Record<string, RoomParticipant> = {}

    for (const [id, rawParticipant] of Object.entries(stored.participants)) {
      const participant = { ...rawParticipant } as StoredParticipant
      if (participant.kind === "agent") {
        // An agent participant may optionally carry a subscribe-only media
        // session (see the "agent-media-attach" action) — unlike a human's,
        // it is never populated from tracks/muted/fileChannelReady legacy
        // fields, since an agent never publishes in the current protocol.
        if (participant.capabilities?.text !== true) {
          participant.capabilities = { text: true }
          changed = true
        }
        for (const key of [
          "sessionId",
          "muted",
          "fileChannelReady",
          "tracks",
        ] as const) {
          if (key in participant) {
            delete participant[key]
            changed = true
          }
        }
        if (participant.media && participant.media.tracks.length > 0) {
          participant.media = { ...participant.media, tracks: [] }
          changed = true
        }
        if (participant.media?.agentSubscribedMids !== undefined) {
          const validMids = Array.isArray(participant.media.agentSubscribedMids)
            ? participant.media.agentSubscribedMids
                .filter((mid) => typeof mid === "string" && mid.length > 0)
                .slice(-MAX_AGENT_SUBSCRIBED_MIDS)
            : []
          if (
            validMids.length !== participant.media.agentSubscribedMids.length
          ) {
            participant.media = {
              ...participant.media,
              agentSubscribedMids: validMids,
            }
            changed = true
          }
        }
      } else if (!participant.media && participant.sessionId) {
        participant.media = {
          sessionId: participant.sessionId,
          muted: participant.muted === true,
          fileChannelReady: participant.fileChannelReady === true,
          tracks: participant.tracks ?? [],
        }
        delete participant.sessionId
        delete participant.muted
        delete participant.fileChannelReady
        delete participant.tracks
        changed = true
      }
      participants[id] = participant
    }

    let nextMessageSequence =
      typeof stored.nextMessageSequence === "number" &&
      Number.isSafeInteger(stored.nextMessageSequence) &&
      stored.nextMessageSequence >= 0
        ? stored.nextMessageSequence
        : 0
    const messages: RoomMessage[] = []
    for (const rawMessage of stored.messages ?? []) {
      const sequence =
        typeof rawMessage.sequence === "number" &&
        Number.isSafeInteger(rawMessage.sequence) &&
        rawMessage.sequence > 0
          ? rawMessage.sequence
          : nextMessageSequence + 1
      if (rawMessage.sequence !== sequence) changed = true
      if (sequence > nextMessageSequence) nextMessageSequence = sequence
      const targets = Array.isArray(rawMessage.targets)
        ? [
            ...new Set(
              rawMessage.targets.filter((id) => typeof id === "string")
            ),
          ].slice(0, MAX_TARGETS)
        : undefined
      if (targets?.length !== rawMessage.targets?.length) changed = true
      messages.push({
        ...rawMessage,
        sequence,
        ...(targets?.length ? { targets } : {}),
      })
    }
    if (stored.nextMessageSequence !== nextMessageSequence) changed = true
    const attachments = Array.isArray(stored.attachments)
      ? stored.attachments.filter((attachment) =>
          this.validAttachment(attachment)
        )
      : []
    if (!Array.isArray(stored.attachments)) changed = true

    let meetingNotes: MeetingNotesState
    if (this.validMeetingNotes(stored.meetingNotes)) {
      meetingNotes = stored.meetingNotes
    } else {
      meetingNotes = NO_MEETING_NOTES
      changed = true
    }
    if (
      meetingNotes.active &&
      (!meetingNotes.agentParticipantId ||
        participants[meetingNotes.agentParticipantId]?.kind !== "agent")
    ) {
      // The selected note-taker no longer exists (left, expired, or the
      // stored grant was pointing at a participant that was never an
      // agent) — a stale grant must not silently keep authorizing media.
      meetingNotes = NO_MEETING_NOTES
      changed = true
    }

    return {
      room: {
        createdAt: stored.createdAt,
        expiresAt: stored.expiresAt,
        participants,
        messages,
        attachments,
        nextMessageSequence,
        meetingNotes,
      },
      changed,
    }
  }

  private validMeetingNotes(value: unknown): value is MeetingNotesState {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<MeetingNotesState>
    if (typeof candidate.active !== "boolean") return false
    if (!candidate.active) return true
    return (
      typeof candidate.agentParticipantId === "string" &&
      candidate.agentParticipantId.length > 0 &&
      typeof candidate.startedAt === "number"
    )
  }

  private async saveRoom(room: RoomRecord): Promise<void> {
    await this.ctx.storage.put("room", room)
  }

  private validAttachment(value: unknown): value is RoomAttachment {
    if (!value || typeof value !== "object") return false
    const attachment = value as Partial<RoomAttachment>
    return (
      typeof attachment.id === "string" &&
      typeof attachment.senderId === "string" &&
      typeof attachment.senderName === "string" &&
      (attachment.mimeType === "image/jpeg" ||
        attachment.mimeType === "image/png" ||
        attachment.mimeType === "image/webp") &&
      typeof attachment.fileName === "string" &&
      typeof attachment.size === "number" &&
      Number.isSafeInteger(attachment.size) &&
      attachment.size > 0 &&
      attachment.size <= MAX_AGENT_IMAGE_BYTES &&
      typeof attachment.chunkCount === "number" &&
      Number.isSafeInteger(attachment.chunkCount) &&
      attachment.chunkCount > 0 &&
      attachment.chunkCount <=
        Math.ceil(MAX_AGENT_IMAGE_BYTES / ATTACHMENT_CHUNK_SIZE) &&
      typeof attachment.createdAt === "number" &&
      typeof attachment.sequence === "number"
    )
  }

  private attachmentChunkKey(id: string, index: number): string {
    return `attachment:${id}:${index}`
  }

  private async deleteAttachmentChunks(
    attachment: Pick<RoomAttachment, "id" | "chunkCount">
  ): Promise<void> {
    for (let index = 0; index < attachment.chunkCount; index += 1)
      await this.ctx.storage.delete(
        this.attachmentChunkKey(attachment.id, index)
      )
  }

  private stateFor(room: RoomRecord): RoomState {
    return {
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      participants: Object.values(room.participants)
        .filter((participant) => participant.connected)
        .map(({ token: _token, connectionNonce: _nonce, ...participant }) => {
          // agentSubscribedMids is Cloudflare session bookkeeping used only
          // for server-side revocation (see realtimeMedia.ts) — never
          // participant-visible state.
          if (!participant.media?.agentSubscribedMids) return participant
          const { agentSubscribedMids: _mids, ...media } = participant.media
          return { ...participant, media }
        }),
      messages: room.messages,
      meetingNotes: room.meetingNotes,
      meetingNotesMediaAvailable: this.env.AGENT_MEDIA_ENABLED === "true",
    }
  }

  private participantForInfo(participant: RoomParticipant) {
    const {
      token: _token,
      connectionNonce: _nonce,
      media: _media,
      ...safeParticipant
    } = participant
    return safeParticipant
  }

  private json(data: unknown, status = 200): Response {
    return Response.json(data, { status })
  }

  private isExpired(room: RoomRecord): boolean {
    return Date.now() >= room.expiresAt
  }

  // Recomputes room.expiresAt from current participant count. Must run after
  // every mutation that adds or removes a participant. See roomExpiry.ts.
  private applyEmptyRoomExpiry(room: RoomRecord, now: number): void {
    room.expiresAt = computeExpiresAt(
      Object.keys(room.participants).length,
      room.expiresAt,
      now
    )
  }

  private async activeRoom(): Promise<RoomRecord | null> {
    const room = await this.loadRoom()
    if (!room) return null
    if (this.isExpired(room)) {
      await this.expireRoom(room)
      return null
    }
    return room
  }

  // The real revocation boundary for Meeting Notes (finding #3): actively
  // closes the granted Agent's already-established Cloudflare Realtime
  // remote-track subscriptions, not just the room-state grant. Must be
  // called (and awaited) *before* the participant is removed from
  // room.participants at every departure/expiry site, since it needs
  // media.sessionId/agentSubscribedMids to still be present. No-ops
  // cheaply when there is nothing to close (ordinary text-only agents, or
  // an agent that was granted but never actually subscribed to anything).
  private async closeAgentMediaTracks(
    room: RoomRecord,
    agentParticipantId: string
  ): Promise<void> {
    const participant = room.participants[agentParticipantId]
    if (!participant || participant.kind !== "agent" || !participant.media)
      return
    const mids = participant.media.agentSubscribedMids
    if (!mids || mids.length === 0) return
    const sessionId = participant.media.sessionId
    participant.media = { ...participant.media, agentSubscribedMids: [] }
    try {
      await closeRealtimeTracks(this.env, sessionId, mids)
    } catch {
      // Best-effort — see closeRealtimeTracks's own comment. The room-state
      // mutation that triggered this call must still succeed, and every
      // subsequent Agent media request independently re-checks the current
      // grant regardless of whether this specific close call succeeded.
    }
  }

  private async expireRoom(room: RoomRecord): Promise<void> {
    if (room.meetingNotes.active && room.meetingNotes.agentParticipantId) {
      await this.closeAgentMediaTracks(
        room,
        room.meetingNotes.agentParticipantId
      )
    }
    for (const attachment of room.attachments)
      await this.deleteAttachmentChunks(attachment)
    await this.ctx.storage.delete("room")
    for (const waiter of this.agentWaiters.values()) {
      if (!waiter) continue
      clearTimeout(waiter.timer)
      waiter.resolve(
        this.json({
          events: [],
          cursor: room.nextMessageSequence,
          expiresAt: room.expiresAt,
          expired: true,
        })
      )
    }
    this.agentWaiters.clear()
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
    room?: RoomRecord,
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

  private async scheduleNextAlarm(room: RoomRecord): Promise<void> {
    const deadlines = [room.expiresAt]
    for (const participant of Object.values(room.participants)) {
      if (participant.kind === "agent") {
        deadlines.push(participant.lastSeenAt + AGENT_LEASE_MS)
      } else if (!participant.connected) {
        deadlines.push(participant.lastSeenAt + RECONNECT_GRACE_MS)
      }
    }
    await this.ctx.storage.setAlarm(Math.min(...deadlines))
  }

  private findParticipant(
    room: RoomRecord,
    participantId: string,
    token: string,
    sessionId?: string
  ): RoomParticipant | null {
    const participant = room.participants[participantId]
    if (!participant || participant.token !== token) return null
    if (sessionId && participant.media?.sessionId !== sessionId) return null
    return participant
  }

  private appendMessage(
    room: RoomRecord,
    message: Omit<RoomMessage, "sequence">
  ): RoomMessage {
    const roomMessage = {
      ...message,
      sequence: room.nextMessageSequence + 1,
    }
    room.nextMessageSequence = roomMessage.sequence
    room.messages = [...room.messages, roomMessage].slice(-MAX_MESSAGES)
    return roomMessage
  }

  private toAgentEvent(
    message: RoomMessage,
    participantId: string
  ): AgentEvent {
    return {
      sequence: message.sequence,
      type: message.type,
      participant: {
        id: message.peerId,
        name: message.name,
        kind: message.kind,
      },
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.actionType === undefined
        ? {}
        : { actionType: message.actionType }),
      ...(message.actionPayload === undefined
        ? {}
        : { actionPayload: message.actionPayload }),
      addressed: message.targets?.includes(participantId) === true,
      createdAt: message.createdAt,
    }
  }

  private toAttachmentEvent(attachment: RoomAttachment): AgentEvent {
    return {
      sequence: attachment.sequence,
      type: "image",
      participant: {
        id: attachment.senderId,
        name: attachment.senderName,
        kind: "human",
      },
      attachment: {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
      addressed: false,
      createdAt: attachment.createdAt,
    }
  }

  private agentEvents(
    room: RoomRecord,
    participantId: string,
    cursor: number
  ): {
    events: AgentEvent[]
    cursor: number
    expiresAt: number
    truncated?: boolean
  } {
    const serverCursor = room.nextMessageSequence
    const clampedCursor = Math.min(Math.max(cursor, 0), serverCursor)
    const events = [
      ...room.messages.map((message) => ({
        sequence: message.sequence,
        event: this.toAgentEvent(message, participantId),
        peerId: message.peerId,
      })),
      ...room.attachments.map((attachment) => ({
        sequence: attachment.sequence,
        event: this.toAttachmentEvent(attachment),
        peerId: attachment.senderId,
      })),
    ].sort((left, right) => left.sequence - right.sequence)
    const firstSequence = events[0]?.sequence
    const truncated =
      firstSequence !== undefined && clampedCursor < firstSequence - 1
    const effectiveCursor = truncated ? firstSequence - 1 : clampedCursor
    return {
      events: events
        .filter(
          (entry) =>
            entry.sequence > effectiveCursor && entry.peerId !== participantId
        )
        .map((entry) => entry.event),
      cursor: serverCursor,
      expiresAt: room.expiresAt,
      ...(truncated ? { truncated: true } : {}),
    }
  }

  private finishWaiter(waiter: AgentWaiter, response: Response): void {
    clearTimeout(waiter.timer)
    if (this.agentWaiters.get(waiter.participantId) === waiter)
      this.agentWaiters.delete(waiter.participantId)
    waiter.resolve(response)
  }

  private resolveAgentWaiters(room: RoomRecord): void {
    for (const waiter of this.agentWaiters.values()) {
      if (!waiter) continue
      const result = this.agentEvents(room, waiter.participantId, waiter.cursor)
      if (
        result.events.length > 0 ||
        result.cursor > waiter.cursor ||
        result.truncated
      ) {
        this.finishWaiter(waiter, this.json(result))
      }
    }
  }

  private async waitForAgent(
    request: Extract<ControlRequest, { action: "agent-wait" }>
  ): Promise<Response> {
    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)
    const participant = this.findParticipant(
      room,
      request.participantId,
      request.token
    )
    if (!participant) return this.json({ error: "unauthorized" }, 401)
    if (participant.kind !== "agent")
      return this.json({ error: "agent_only" }, 403)
    if (this.agentWaiters.has(participant.id))
      return this.json({ error: "wait_already_pending" }, 409)

    this.agentWaiters.set(participant.id, null)

    try {
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)

      const result = this.agentEvents(room, participant.id, request.cursor)
      const cursorWasAhead = request.cursor > room.nextMessageSequence
      if (
        cursorWasAhead ||
        result.events.length > 0 ||
        result.cursor > request.cursor ||
        result.truncated ||
        request.timeoutSeconds === 0
      ) {
        this.agentWaiters.delete(participant.id)
        return this.json(result)
      }

      return new Promise<Response>((resolve) => {
        const waiter: AgentWaiter = {
          participantId: participant.id,
          cursor: request.cursor,
          resolve,
          timer: setTimeout(() => {
            if (this.agentWaiters.get(participant.id) !== waiter) return
            this.agentWaiters.delete(participant.id)
            void this.activeRoom().then((current) => {
              if (!current) {
                resolve(
                  this.json({
                    events: [],
                    cursor: room.nextMessageSequence,
                    expiresAt: room.expiresAt,
                    expired: true,
                  })
                )
                return
              }
              resolve(
                this.json(
                  this.agentEvents(current, participant.id, request.cursor)
                )
              )
            })
          }, request.timeoutSeconds * 1000),
        }
        this.agentWaiters.set(participant.id, waiter)
      })
    } catch (error) {
      this.agentWaiters.delete(participant.id)
      throw error
    }
  }

  private async handleControl(request: ControlRequest): Promise<Response> {
    if (request.action === "room-info") {
      const room = await this.activeRoom()
      return this.json({
        exists: room !== null,
        expiresAt: room?.expiresAt ?? null,
        participants: room
          ? Object.values(room.participants)
              .filter((participant) => participant.connected)
              .map((participant) => this.participantForInfo(participant))
          : [],
        capabilities: ROOM_CAPABILITIES,
        // Room-visible state, not a capability secret — the same
        // agentParticipantId is already visible in `participants` above.
        meetingNotes: room?.meetingNotes ?? NO_MEETING_NOTES,
        meetingNotesMediaAvailable: this.env.AGENT_MEDIA_ENABLED === "true",
      })
    }

    if (request.action === "agent-wait") return this.waitForAgent(request)

    if (request.action === "register" || request.action === "agent-register") {
      const now = Date.now()
      let room = await this.loadRoom()
      if (room && this.isExpired(room)) {
        await this.expireRoom(room)
        return this.json({ error: "room_expired" }, 410)
      }
      if (!room) {
        room = {
          createdAt: now,
          expiresAt: NO_EXPIRY,
          participants: {},
          messages: [],
          attachments: [],
          nextMessageSequence: 0,
          meetingNotes: NO_MEETING_NOTES,
        }
      }
      const isAgent = request.action === "agent-register"
      if (room.participants[request.participant.id])
        return this.json({ error: "participant_exists" }, 409)
      if (
        (isAgent && request.participant.kind !== "agent") ||
        (!isAgent &&
          (request.participant.kind !== "human" || !request.participant.media))
      ) {
        return this.json({ error: "invalid_participant_kind" }, 400)
      }
      const participant: RoomParticipant = {
        ...request.participant,
        connected: isAgent,
        lastSeenAt: now,
        ...(isAgent ? { capabilities: { text: true }, media: undefined } : {}),
      }
      room.participants[participant.id] = participant
      this.applyEmptyRoomExpiry(room, now)
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      if (isAgent) {
        await this.broadcastState(room)
        return this.json({
          participant: this.participantForInfo(participant),
          cursor: room.nextMessageSequence,
          expiresAt: room.expiresAt,
        })
      }
      return this.json({
        state: this.stateFor(room),
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-send-text") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      const text = request.text.trim()
      if (!text) return this.json({ error: "text_required" }, 400)
      participant.lastSeenAt = Date.now()
      const roomMessage = this.appendMessage(room, {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "text",
        text: text.slice(0, 4000),
        createdAt: Date.now(),
      })
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      await this.broadcast({ type: "message", message: roomMessage })
      this.resolveAgentWaiters(room)
      return this.json({
        sequence: roomMessage.sequence,
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-media-attach") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // Subscribe-only: an agent never publishes in the current protocol,
      // so its media state never carries tracks of its own.
      participant.media = {
        sessionId: request.sessionId,
        muted: true,
        fileChannelReady: false,
        tracks: [],
      }
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({ ok: true, expiresAt: room.expiresAt })
    }

    if (request.action === "agent-room-media") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      // The real authorization boundary: this agent must be the one
      // Human-selected note-taker for an *active* Meeting Notes grant on
      // this room. Holding a valid agent participant token is necessary
      // but never sufficient — an ordinary text-only agent that joined
      // the room but was never granted the Meeting Notes role is rejected
      // here even though its token is perfectly valid. AGENT_MEDIA_ENABLED
      // (sfu/server.ts) is an additional, coarser master switch on top of
      // this — off, it blocks everyone regardless of any room grant; on,
      // it still requires this per-room, per-agent grant to actually see
      // Human media. Setting it alone was never meant to be sufficient.
      if (!isAgentAuthorizedForMedia(room.meetingNotes, participant.id))
        return this.json({ error: "meeting_notes_not_authorized" }, 403)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      // Deliberately narrower than participantForInfo/room-info: this is
      // not exposed through the MCP tool surface. Only Human media is
      // exposed — Phase 0 MediaBridge only ever ingests Human audio.
      const participants = Object.values(room.participants)
        .filter(
          (
            candidate
          ): candidate is RoomParticipant & {
            media: NonNullable<RoomParticipant["media"]>
          } =>
            candidate.kind === "human" &&
            candidate.connected &&
            Boolean(candidate.media)
        )
        .map((candidate) => ({
          participantId: candidate.id,
          name: candidate.name,
          sessionId: candidate.media.sessionId,
          tracks: candidate.media.tracks,
        }))
      return this.json({ participants, expiresAt: room.expiresAt })
    }

    if (request.action === "agent-track-subscribed") {
      // Records the Cloudflare-assigned mid(s) for the granted Agent's
      // remote (subscribe) track negotiations, so an active Meeting Notes
      // revocation can actually close them server-side (see
      // closeAgentMediaTracks/realtimeMedia.ts) instead of only preventing
      // *future* subscriptions. Bounded scratch state — see
      // MAX_AGENT_SUBSCRIBED_MIDS.
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      if (!isAgentAuthorizedForMedia(room.meetingNotes, participant.id))
        return this.json({ error: "meeting_notes_not_authorized" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      const mids = request.mids.filter(
        (mid) => typeof mid === "string" && mid.length > 0
      )
      participant.media.agentSubscribedMids = [
        ...new Set([...(participant.media.agentSubscribedMids ?? []), ...mids]),
      ].slice(-MAX_AGENT_SUBSCRIBED_MIDS)
      await this.saveRoom(room)
      return this.json({ ok: true })
    }

    if (request.action === "agent-read-attachment") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "unauthorized" }, 401)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      const attachment = room.attachments.find(
        (candidate) => candidate.id === request.attachmentId
      )
      if (!attachment)
        return this.json({ error: "attachment_unavailable" }, 404)

      const chunks: Uint8Array[] = []
      for (let index = 0; index < attachment.chunkCount; index += 1) {
        const chunk = await this.ctx.storage.get<ArrayBuffer>(
          this.attachmentChunkKey(attachment.id, index)
        )
        if (!chunk) return this.json({ error: "attachment_unavailable" }, 404)
        chunks.push(new Uint8Array(chunk))
      }
      let binary = ""
      for (const chunk of chunks)
        for (const byte of chunk) binary += String.fromCharCode(byte)
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({
        attachment: {
          id: attachment.id,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
        },
        data: btoa(binary),
        expiresAt: room.expiresAt,
      })
    }

    if (request.action === "agent-leave") {
      const room = await this.activeRoom()
      if (!room) return this.json({ error: "room_expired" }, 410)
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token
      )
      if (!participant) return this.json({ error: "already_left" }, 404)
      if (participant.kind !== "agent")
        return this.json({ error: "agent_only" }, 403)
      await this.closeAgentMediaTracks(room, participant.id)
      delete room.participants[participant.id]
      room.meetingNotes = clearGrantIfParticipantDeparting(
        room.meetingNotes,
        participant.id
      )
      this.applyEmptyRoomExpiry(room, Date.now())
      await this.saveRoom(room)
      const waiter = this.agentWaiters.get(participant.id)
      if (waiter) {
        this.finishWaiter(
          waiter,
          this.json({
            events: [],
            cursor: room.nextMessageSequence,
            expiresAt: room.expiresAt,
            left: true,
          })
        )
      } else {
        this.agentWaiters.delete(participant.id)
      }
      await this.broadcastState(room)
      await this.scheduleNextAlarm(room)
      return this.json({ ok: true })
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
      // Finding #2: the generic authorize() gate backs every subsequent
      // Agent media operation (/tracks, /renegotiate, /tracks/close,
      // /datachannels/*), not just the initial agent-room-media discovery
      // call — so a previously-authorized Agent that already knows its own
      // sessionId and a Human's sessionId/trackName cannot keep creating
      // subscriptions via cached identifiers after Stop/reassignment. Human
      // authorization is completely unaffected.
      if (
        participant.kind === "agent" &&
        !isAgentAuthorizedForMedia(room.meetingNotes, participant.id)
      )
        return this.json({ error: "meeting_notes_not_authorized" }, 403)
      if (request.trackSessionId && request.trackName) {
        const trackExists = Object.values(room.participants).some(
          (candidate) =>
            candidate.media?.sessionId === request.trackSessionId &&
            candidate.media.tracks.some(
              (track) => track.trackName === request.trackName
            )
        )
        if (!trackExists) return this.json({ error: "track_not_found" }, 404)
      }
      if (request.dataChannelSessionId) {
        const sessionExists = Object.values(room.participants).some(
          (candidate) =>
            candidate.media?.sessionId === request.dataChannelSessionId &&
            candidate.connected
        )
        if (!sessionExists)
          return this.json({ error: "datachannel_session_not_found" }, 404)
      }
      // kind lets the Worker enforce protocol-level invariants (e.g. an
      // agent's media session must stay subscribe-only) before forwarding
      // a request upstream to Cloudflare Realtime — see /api/sfu/tracks.
      return this.json({ ok: true, kind: participant.kind })
    }

    if (request.action === "reconnect") {
      const participant = this.findParticipant(
        room,
        request.participantId,
        request.token,
        request.sessionId
      )
      if (!participant || !participant.media)
        return this.json({ error: "unauthorized" }, 401)
      participant.media = {
        ...participant.media,
        sessionId: request.newSessionId,
        fileChannelReady: false,
        tracks: [],
      }
      participant.connected = false
      participant.connectionNonce = undefined
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      await this.scheduleNextAlarm(room)
      return this.json({ ok: true, expiresAt: room.expiresAt })
    }

    const participant = this.findParticipant(
      room,
      request.participantId,
      request.token
    )
    if (!participant) return this.json({ error: "unauthorized" }, 401)

    if (request.action === "publish") {
      // Defense in depth: /api/sfu/tracks already rejects an agent's
      // "local" track before it ever reaches Cloudflare Realtime, so this
      // should be unreachable for an agent in practice — but the room
      // model itself must not accept an agent publication either. Phase-0
      // agent media capability is subscribe-only, full stop.
      if (participant.kind === "agent")
        return this.json({ error: "agent_publish_not_allowed" }, 403)
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      participant.media.tracks = [
        ...participant.media.tracks.filter(
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
          sessionId: participant.media.sessionId,
          track: request.track,
        },
      })
      return this.json({ ok: true })
    }

    if (request.action === "unpublish") {
      if (!participant.media)
        return this.json({ error: "media_unavailable" }, 400)
      participant.media.tracks = participant.media.tracks.filter(
        (track) => track.trackName !== request.trackName
      )
      await this.saveRoom(room)
      await this.broadcastState(room)
      return this.json({ ok: true })
    }

    delete room.participants[participant.id]
    room.meetingNotes = clearGrantIfParticipantDeparting(
      room.meetingNotes,
      participant.id
    )
    this.applyEmptyRoomExpiry(room, Date.now())
    await this.saveRoom(room)
    await this.broadcastState(room)
    await this.scheduleNextAlarm(room)
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
    if (!participant || participant.kind !== "human" || !participant.media) {
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
      this.applyEmptyRoomExpiry(room, Date.now())
      await this.saveRoom(room)
      await this.broadcastState(room)
      await this.scheduleNextAlarm(room)
      socket.close(1000, "Left room")
      return
    }
    if (message.type === "mute") {
      participant.media.muted = message.muted
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "unpublish") {
      participant.media.tracks = participant.media.tracks.filter(
        (track) => track.trackName !== message.trackName
      )
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "datachannel-ready") {
      participant.media.fileChannelReady = true
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "meeting-notes-start") {
      // The room-visible grant must never be able to claim "active" in an
      // environment where the master switch is off — every actual Runtime
      // media request would 403 regardless, and the browser must not show
      // "Listening" for a capability that cannot possibly be delivered.
      if (this.env.AGENT_MEDIA_ENABLED !== "true") {
        socket.send(
          JSON.stringify({
            type: "error",
            error: "meeting_notes_media_disabled",
          })
        )
        return
      }
      const agent = room.participants[message.agentParticipantId]
      if (!agent || agent.kind !== "agent" || !agent.connected) {
        socket.send(
          JSON.stringify({ type: "error", error: "agent_not_in_room" })
        )
        return
      }
      const previousAgentId = room.meetingNotes.agentParticipantId
      room.meetingNotes = startMeetingNotes(agent.id, Date.now())
      // Reassignment (A -> B): A's already-established subscription must be
      // torn down, not merely left to expire on its own lease.
      if (previousAgentId && previousAgentId !== agent.id)
        await this.closeAgentMediaTracks(room, previousAgentId)
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }
    if (message.type === "meeting-notes-stop") {
      const previousAgentId = room.meetingNotes.agentParticipantId
      room.meetingNotes = NO_MEETING_NOTES
      if (previousAgentId)
        await this.closeAgentMediaTracks(room, previousAgentId)
      await this.saveRoom(room)
      await this.broadcastState(room)
      return
    }

    if (message.type === "chat" && message.text.trim()) {
      const roomMessage = this.appendMessage(room, {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "text",
        text: message.text.trim().slice(0, 4000),
        ...(() => {
          const targets = [
            ...new Set(
              (Array.isArray(message.targets) ? message.targets : [])
                .filter((id): id is string => typeof id === "string")
                .filter((id) => room.participants[id]?.kind === "agent")
            ),
          ].slice(0, MAX_TARGETS)
          return targets.length ? { targets } : {}
        })(),
        createdAt: Date.now(),
      })
      await this.saveRoom(room)
      await this.broadcast({ type: "message", message: roomMessage })
      this.resolveAgentWaiters(room)
      return
    }

    if (message.type === "action") {
      const roomMessage = this.appendMessage(room, {
        id: crypto.randomUUID(),
        peerId: participant.id,
        name: participant.name,
        kind: participant.kind,
        type: "action",
        actionType: message.actionType,
        actionPayload: message.actionPayload,
        createdAt: Date.now(),
      })
      await this.saveRoom(room)
      await this.broadcast({ type: "message", message: roomMessage })
      this.resolveAgentWaiters(room)
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/attachment")
      return this.handleAttachmentUpload(request)
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
      if (
        !room ||
        !participant ||
        participant.kind !== "human" ||
        !participant.media
      )
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

  private isAgentImageMimeType(value: string): value is AgentImageMimeType {
    return (
      value === "image/jpeg" || value === "image/png" || value === "image/webp"
    )
  }

  private async handleAttachmentUpload(request: Request): Promise<Response> {
    const room = await this.activeRoom()
    if (!room) return this.json({ error: "room_expired" }, 410)
    const participantId = request.headers.get("X-Room-Participant-Id") ?? ""
    const token = request.headers.get("X-Room-Participant-Token") ?? ""
    const participant = this.findParticipant(room, participantId, token)
    if (!participant) return this.json({ error: "unauthorized" }, 401)
    if (participant.kind !== "human")
      return this.json({ error: "human_only" }, 403)

    const mimeType = (request.headers.get("Content-Type") ?? "")
      .split(";", 1)[0]
      .toLowerCase()
    if (!this.isAgentImageMimeType(mimeType))
      return this.json({ error: "unsupported_image_type" }, 415)
    const declaredSize = Number(request.headers.get("Content-Length") ?? "0")
    if (declaredSize > MAX_AGENT_IMAGE_BYTES)
      return this.json({ error: "attachment_too_large" }, 413)
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_AGENT_IMAGE_BYTES ||
      (declaredSize > 0 && declaredSize !== bytes.byteLength)
    )
      return this.json({ error: "invalid_attachment" }, 400)

    let fileName = request.headers.get("X-File-Name") ?? "image"
    try {
      fileName = decodeURIComponent(fileName)
    } catch {
      fileName = "image"
    }
    fileName = fileName.trim().slice(0, 256) || "image"
    const id = crypto.randomUUID()
    const chunkCount = Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_SIZE)
    const attachment: RoomAttachment = {
      id,
      senderId: participant.id,
      senderName: participant.name,
      mimeType,
      fileName,
      size: bytes.byteLength,
      chunkCount,
      createdAt: Date.now(),
      sequence: room.nextMessageSequence + 1,
    }
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * ATTACHMENT_CHUNK_SIZE
        await this.ctx.storage.put(
          this.attachmentChunkKey(id, index),
          bytes.slice(start, start + ATTACHMENT_CHUNK_SIZE)
        )
      }
      room.nextMessageSequence = attachment.sequence
      room.attachments = [...room.attachments, attachment]
      const evicted = room.attachments.splice(
        0,
        Math.max(0, room.attachments.length - MAX_AGENT_ATTACHMENTS)
      )
      participant.lastSeenAt = Date.now()
      await this.saveRoom(room)
      for (const oldAttachment of evicted)
        await this.deleteAttachmentChunks(oldAttachment)
      await this.scheduleNextAlarm(room)
      this.resolveAgentWaiters(room)
      return this.json({ attachment: { ...attachment } })
    } catch {
      await this.deleteAttachmentChunks(attachment)
      return this.json({ error: "attachment_unavailable" }, 503)
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
    await this.scheduleNextAlarm(room)
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
    let changed = false
    for (const [id, participant] of Object.entries(room.participants)) {
      const expiredHuman =
        participant.kind === "human" &&
        !participant.connected &&
        participant.lastSeenAt + RECONNECT_GRACE_MS <= now
      const expiredAgent =
        participant.kind === "agent" &&
        participant.lastSeenAt + AGENT_LEASE_MS <= now
      if (expiredHuman || expiredAgent) {
        if (expiredAgent) await this.closeAgentMediaTracks(room, id)
        delete room.participants[id]
        room.meetingNotes = clearGrantIfParticipantDeparting(
          room.meetingNotes,
          id
        )
        changed = true
        const waiter = this.agentWaiters.get(id)
        if (waiter) {
          this.finishWaiter(
            waiter,
            this.json({
              events: [],
              cursor: room.nextMessageSequence,
              expiresAt: room.expiresAt,
              left: true,
            })
          )
        } else {
          this.agentWaiters.delete(id)
        }
      }
    }
    if (changed) {
      this.applyEmptyRoomExpiry(room, now)
      await this.saveRoom(room)
      await this.broadcastState(room)
    }
    await this.scheduleNextAlarm(room)
  }
}
