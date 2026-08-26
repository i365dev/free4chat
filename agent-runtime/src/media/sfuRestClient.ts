import type { DecodedParticipantHandle } from "./participantHandle.js"

export interface RoomMediaTrackInfo {
  trackName: string
  kind: "audio" | "video"
  mid?: string
}

export interface RoomMediaParticipant {
  participantId: string
  name: string
  sessionId: string
  tracks: RoomMediaTrackInfo[]
}

export interface SessionDescriptionLike {
  type: string
  sdp?: string
  /** Cloudflare's mid for the newly requested remote track, when this is an
   * offer returned by /tracks. It is intentionally optional for test fakes and
   * non-SFU descriptions. */
  mid?: string
}

export interface DataChannelTransportLike {
  sessionDescription?: SessionDescriptionLike
  requiresImmediateRenegotiation?: boolean
}

/** #83 review: the narrow, typed purpose every Agent signaling request must
 * carry. The Worker/DO re-checks the matching room grant per purpose and
 * fails closed when it is missing or unknown — never Agent token alone:
 *   agent-transport  initial shared transport bootstrap (meetingNotes OR
 *                    voiceReply must name this agent)
 *   meeting-notes    remote Human-audio subscribe (Meeting Notes grant)
 *   voice-reply      local single-audio publish (voiceReply grant)
 */
export type SfuSignalPurpose =
  "meeting-notes" | "voice-reply" | "agent-transport"

/**
 * DOM and werift descriptions are class instances. Cross the REST boundary
 * with the browser's literal `{ type, sdp }` shape instead of relying on a
 * library instance's JSON serialization.
 */
function sessionDescriptionPayload(description: SessionDescriptionLike): {
  type: string
  sdp: string
} {
  if (
    typeof description.type !== "string" ||
    typeof description.sdp !== "string"
  )
    throw new Error("invalid_session_description")
  return { type: description.type, sdp: description.sdp }
}

/** The subset of SfuRestClient that SfuMediaBridge depends on — kept as an
 * interface so tests can inject a fake instead of doing real network I/O. */
export interface SfuRestClientLike {
  createAgentSession(): Promise<string>
  /** Native initial-offer contract (deployed): session creation carries the
   * gathered offer and returns Cloudflare's answer directly. Optional so
   * legacy fakes stay valid; the bridge falls back when absent. */
  createAgentSessionWithOffer?(offer: SessionDescriptionLike): Promise<{
    sessionId: string
    sessionDescription?: SessionDescriptionLike
  }>
  establishDataChannelTransport(
    mySessionId: string,
    offer: SessionDescriptionLike | undefined,
    purpose: SfuSignalPurpose
  ): Promise<DataChannelTransportLike>
  roomMedia(): Promise<RoomMediaParticipant[]>
  subscribeTrack(
    mySessionId: string,
    remoteSessionId: string,
    trackName: string,
    purpose: SfuSignalPurpose
  ): Promise<SessionDescriptionLike>
  renegotiate(
    mySessionId: string,
    answer: SessionDescriptionLike,
    purpose: SfuSignalPurpose
  ): Promise<void>
  /** #83 voiceReply: activates this agent's single outbound audio track
   * (already negotiated into the initial offer) on the upstream SFU. */
  publishAudioTrack?(
    mySessionId: string,
    args: { trackName: string; mid: string; offer: SessionDescriptionLike }
  ): Promise<{ sessionDescription?: SessionDescriptionLike }>
  /** Confirms Cloudflare has observed the publication as active after a PCM
   * write; the Worker exposes it to Humans only on a positive result. */
  confirmPublishedAudioTrackActive?(
    mySessionId: string,
    trackName: string
  ): Promise<boolean>
}

/**
 * Thin REST client for the app's /api/sfu/* endpoints — the same ones the
 * browser client (useSfuChatRoom.ts) already uses for tracks/renegotiate,
 * plus the Agent-only endpoints added alongside this PR
 * (agent-session, agent-room-media). No SFU/Cloudflare credentials ever
 * live here — only the participant token this Agent already holds from
 * its normal room join.
 */
export class SfuRestClient implements SfuRestClientLike {
  constructor(
    private readonly siteOrigin: string,
    private readonly handle: DecodedParticipantHandle
  ) {}

  private async request(
    path: string,
    method: "GET" | "POST" | "PUT",
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.siteOrigin}/api/sfu/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const raw = await response.text()
    const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (!response.ok) {
      // Bounded diagnostics only: Cloudflare's stable machine code (or the
      // HTTP status) — never the response body, SDP or errorDescription.
      const errorCode =
        typeof data.errorCode === "string" ? data.errorCode : undefined
      const error =
        typeof data.error === "string"
          ? data.error
          : errorCode
            ? `sfu_${path.replaceAll("/", "_")}_${errorCode}`
            : `SFU request failed (${response.status})`
      throw new Error(error)
    }
    return data
  }

  private base() {
    return {
      room: this.handle.room,
      participantId: this.handle.participantId,
      token: this.handle.participantToken,
    }
  }

  /** Creates this Agent's own Cloudflare Realtime session (subscribe-only). */
  async createAgentSessionWithOffer(offer: SessionDescriptionLike): Promise<{
    sessionId: string
    sessionDescription?: SessionDescriptionLike
  }> {
    const data = await this.request("agent-session", "POST", {
      ...this.base(),
      sessionDescription: sessionDescriptionPayload(offer),
    })
    if (typeof data.sessionId !== "string")
      throw new Error("agent_session_invalid")
    const sd =
      data.sessionDescription &&
      typeof data.sessionDescription === "object" &&
      typeof (data.sessionDescription as { type?: unknown }).type ===
        "string" &&
      typeof (data.sessionDescription as { sdp?: unknown }).sdp === "string"
        ? {
            type: (data.sessionDescription as { type: string }).type,
            sdp: (data.sessionDescription as { sdp: string }).sdp,
          }
        : undefined
    return {
      sessionId: data.sessionId,
      ...(sd ? { sessionDescription: sd } : {}),
    }
  }

  async createAgentSession(): Promise<string> {
    const data = await this.request("agent-session", "POST", this.base())
    if (typeof data.sessionId !== "string")
      throw new Error("agent_session_invalid")
    return data.sessionId
  }

  /** Creates the initial WebRTC transport exactly as the browser does. The
   * server-events DataChannel is transport plumbing only for Meeting Notes;
   * no DataChannel payload is observed or forwarded by this Runtime. */
  async establishDataChannelTransport(
    mySessionId: string,
    offer: SessionDescriptionLike | undefined,
    purpose: SfuSignalPurpose
  ): Promise<DataChannelTransportLike> {
    const data = await this.request("datachannels/establish", "POST", {
      ...this.base(),
      sessionId: mySessionId,
      purpose,
      dataChannel: { location: "remote", dataChannelName: "server-events" },
      ...(offer
        ? { sessionDescription: sessionDescriptionPayload(offer) }
        : {}),
    })
    const sessionDescription = data.sessionDescription as
      SessionDescriptionLike | undefined
    if (sessionDescription && !sessionDescription.sdp)
      throw new Error("invalid_datachannel_session_description")
    return {
      ...(sessionDescription ? { sessionDescription } : {}),
      ...(data.requiresImmediateRenegotiation === true
        ? { requiresImmediateRenegotiation: true }
        : {}),
    }
  }

  /**
   * Human participants' sessionId/trackName — deliberately not exposed by
   * the sanitized MCP room_info tool; this endpoint authenticates with the
   * same participant token instead.
   */
  async roomMedia(): Promise<RoomMediaParticipant[]> {
    const data = await this.request("agent-room-media", "POST", this.base())
    const participants = Array.isArray(data.participants)
      ? data.participants
      : []
    return participants.filter(
      (p): p is RoomMediaParticipant =>
        Boolean(p) &&
        typeof p === "object" &&
        typeof (p as RoomMediaParticipant).participantId === "string" &&
        typeof (p as RoomMediaParticipant).sessionId === "string" &&
        Array.isArray((p as RoomMediaParticipant).tracks)
    )
  }

  /** Requests a "remote" subscription; returns Cloudflare's SDP offer. */
  async subscribeTrack(
    mySessionId: string,
    remoteSessionId: string,
    trackName: string,
    purpose: SfuSignalPurpose
  ): Promise<SessionDescriptionLike> {
    const data = await this.request("tracks", "POST", {
      ...this.base(),
      sessionId: mySessionId,
      purpose,
      tracks: [{ location: "remote", sessionId: remoteSessionId, trackName }],
    })
    const description = data.sessionDescription as
      SessionDescriptionLike | undefined
    if (!description?.sdp) throw new Error("no_session_description")
    const tracks = Array.isArray(data.tracks) ? data.tracks : []
    const mid =
      tracks.length > 0 &&
      typeof tracks[0] === "object" &&
      tracks[0] !== null &&
      typeof (tracks[0] as { mid?: unknown }).mid === "string"
        ? (tracks[0] as { mid: string }).mid
        : undefined
    return mid ? { ...description, mid } : description
  }

  async publishAudioTrack(
    mySessionId: string,
    args: { trackName: string; mid: string; offer: SessionDescriptionLike }
  ): Promise<{ sessionDescription?: SessionDescriptionLike }> {
    const data = await this.request("tracks", "POST", {
      ...this.base(),
      sessionId: mySessionId,
      purpose: "voice-reply",
      tracks: [
        {
          location: "local",
          trackName: args.trackName,
          kind: "audio",
          mid: args.mid,
        },
      ],
      sessionDescription: sessionDescriptionPayload(args.offer),
    })
    const description = data.sessionDescription as
      SessionDescriptionLike | undefined
    return description ? { sessionDescription: description } : {}
  }

  async confirmPublishedAudioTrackActive(
    mySessionId: string,
    trackName: string
  ): Promise<boolean> {
    const data = await this.request("agent-track-active", "POST", {
      ...this.base(),
      sessionId: mySessionId,
      trackName,
    })
    return data.active === true
  }

  async renegotiate(
    mySessionId: string,
    answer: SessionDescriptionLike,
    purpose: SfuSignalPurpose
  ): Promise<void> {
    await this.request("renegotiate", "PUT", {
      ...this.base(),
      sessionId: mySessionId,
      purpose,
      sessionDescription: sessionDescriptionPayload(answer),
    })
  }
}

/** Derives the site origin from the MCP endpoint URL (same host, no path). */
export function siteOriginFromMcpUrl(mcpUrl: string): string {
  return new URL(mcpUrl).origin
}
