/** Local, opt-in topology evidence for Lab #221. No payloads, session IDs or tokens. */
export const ROOM_APP_DIAGNOSTIC_CAPACITY = 200

export type RoomAppDiagnosticName =
  | "host_snapshot"
  | "session_started"
  | "media_reconnect_start"
  | "media_reconnect_complete"
  | "media_reconnect_failed"
  | "local_reliable_created"
  | "local_reliable_open"
  | "local_reliable_closed"
  | "remote_reliable_subscribe"
  | "remote_reliable_ready"
  | "remote_reliable_closed"
  | "reliable_send_failed"
  | "reliable_sent"
  | "reliable_received"
  | "reliable_receive_dropped"

export interface RoomAppDiagnosticEvent {
  at: number
  event: RoomAppDiagnosticName
  browserId: string
  participantId?: string
  peerParticipantId?: string
  appInstanceId?: string
  sessionEpoch: number
  localReliableState?: RTCDataChannelState | "absent"
  remoteReliablePeers?: string[]
  reason?:
    | "not_ready"
    | "invalid_envelope"
    | "rate_limited"
    | "channel_unavailable"
    | "closed"
    | "establishment_failed"
    | "media_reconnect"
  protocolType?: "wb_join" | "wb_summary" | "wb_repair_request" | "other"
}

type DiagnosticFields = Omit<
  RoomAppDiagnosticEvent,
  "at" | "browserId" | "participantId" | "sessionEpoch"
>

export class RoomAppTransportDiagnosticTrace {
  readonly browserId: string
  private enabledValue = false
  private participantId: string | undefined
  private sessionEpoch = 0
  private readonly events: RoomAppDiagnosticEvent[] = []
  private snapshotProvider:
    | (() => Pick<
        RoomAppDiagnosticEvent,
        "localReliableState" | "remoteReliablePeers"
      >)
    | null = null

  constructor(
    idFactory: () => string = () =>
      globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  ) {
    this.browserId = idFactory()
  }

  setSnapshotProvider(provider: typeof this.snapshotProvider): void {
    this.snapshotProvider = provider
  }

  get enabled(): boolean {
    return this.enabledValue
  }

  setParticipant(participantId: string): void {
    this.participantId = participantId
    this.sessionEpoch += 1
    this.record({ event: "session_started" })
  }

  current(): RoomAppDiagnosticEvent {
    let state: ReturnType<NonNullable<typeof this.snapshotProvider>> = {}
    try {
      state = this.snapshotProvider?.() ?? {}
    } catch {
      /* Evidence must not affect transport. */
    }
    return {
      at: Date.now(),
      event: "host_snapshot",
      browserId: this.browserId,
      participantId: this.participantId,
      sessionEpoch: this.sessionEpoch,
      ...state,
    }
  }

  enable(): void {
    this.enabledValue = true
    this.events.push(this.current())
    if (this.events.length > ROOM_APP_DIAGNOSTIC_CAPACITY) this.events.shift()
  }

  disable(): void {
    this.enabledValue = false
  }
  clear(): void {
    this.events.length = 0
  }
  read(): RoomAppDiagnosticEvent[] {
    return this.events.map((event) => ({
      ...event,
      remoteReliablePeers: event.remoteReliablePeers?.slice(),
    }))
  }

  record(fields: DiagnosticFields): void {
    if (!this.enabledValue) return
    this.events.push({
      at: Date.now(),
      browserId: this.browserId,
      participantId: this.participantId,
      sessionEpoch: this.sessionEpoch,
      ...fields,
    })
    if (this.events.length > ROOM_APP_DIAGNOSTIC_CAPACITY) this.events.shift()
  }
}

export function whiteboardProtocolType(
  payload: Record<string, unknown>
): RoomAppDiagnosticEvent["protocolType"] {
  switch (payload.type) {
    case "wb_join":
      return "wb_join"
    case "wb_summary":
      return "wb_summary"
    case "wb_repair_request":
      return "wb_repair_request"
    default:
      return "other"
  }
}

declare global {
  interface Window {
    __free4chatRoomAppTransportDiagnostics?: {
      enable(): void
      disable(): void
      clear(): void
      current(): RoomAppDiagnosticEvent
      read(): RoomAppDiagnosticEvent[]
    }
  }
}

export function installRoomAppTransportDiagnostics(
  trace: RoomAppTransportDiagnosticTrace
): () => void {
  const api = {
    enable: () => trace.enable(),
    disable: () => trace.disable(),
    clear: () => trace.clear(),
    current: () => trace.current(),
    read: () => trace.read(),
  }
  window.__free4chatRoomAppTransportDiagnostics = api
  return () => {
    if (window.__free4chatRoomAppTransportDiagnostics === api)
      delete window.__free4chatRoomAppTransportDiagnostics
  }
}
