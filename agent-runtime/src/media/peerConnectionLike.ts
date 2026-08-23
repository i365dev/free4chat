import type { SessionDescriptionLike } from "./sfuRestClient.js"

export interface RtpPacketLike {
  payload: Uint8Array
  header: { timestamp: number }
}

/** The negotiated codec metadata exposed by werift's MediaStreamTrack. */
export interface MediaCodecLike {
  mimeType: string
  clockRate: number
  channels?: number
}

export interface MediaTrackLike {
  kind: "audio" | "video"
  /** The remote SDP m-line this track belongs to. Werift exposes this on the
   * RTCTrackEvent transceiver; keeping it here lets the SFU bridge bind the
   * track to the exact subscription instead of relying on callback order. */
  mid?: string
  codec?: MediaCodecLike
  onReceiveRtp: { subscribe(callback: (packet: RtpPacketLike) => void): void }
}

/**
 * The subset of werift's RTCPeerConnection this module depends on, kept as
 * a narrow interface so unit tests can inject a deterministic fake instead
 * of a real WebRTC/ICE/DTLS stack.
 */
export interface PeerConnectionLike {
  createOffer(): Promise<SessionDescriptionLike>
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>
  createAnswer(): Promise<SessionDescriptionLike>
  setLocalDescription(description: SessionDescriptionLike): Promise<void>
  onTrack: { subscribe(callback: (track: MediaTrackLike) => void): void }
  close(): void
}

export type PeerConnectionFactory = () =>
  PeerConnectionLike | Promise<PeerConnectionLike>

/** The real factory, backed by werift. Kept out of sfuMediaBridge.ts so
 * that file has zero direct werift dependency and stays fully unit-testable. */
export async function createWeriftPeerConnection(): Promise<PeerConnectionLike> {
  const { RTCPeerConnection } = await import("werift")
  // Match Cloudflare's official DataChannel example rather than werift's
  // defaults (Google STUN + max-compat). This connection receives the SFU's
  // server-offer transport bootstrap before any MediaBridge subscription.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle",
  })
  return {
    createOffer: async () =>
      (await pc.createOffer()) as unknown as SessionDescriptionLike,
    setRemoteDescription: async (description) => {
      await pc.setRemoteDescription(
        description as unknown as Parameters<typeof pc.setRemoteDescription>[0]
      )
    },
    createAnswer: async () =>
      (await pc.createAnswer()) as unknown as SessionDescriptionLike,
    setLocalDescription: async (description) => {
      await pc.setLocalDescription(
        description as unknown as Parameters<typeof pc.setLocalDescription>[0]
      )
    },
    onTrack: {
      subscribe: (callback) => {
        // RTCPeerConnection.onTrack only exposes the track and drops the
        // transceiver. The DOM-style ontrack callback retains the transceiver
        // and therefore the negotiated m-line (mid), which is the only stable
        // way to attribute a track after repeated SFU renegotiations.
        pc.ontrack = (event) => {
          const track = event.track as unknown as MediaTrackLike
          track.mid = event.transceiver.mid ?? undefined
          callback(track)
        }
      },
    },
    close: () => pc.close(),
  }
}
