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
  /** Adds the Runtime's single subscribe-only audio m-line before its first
   * SDP offer. This is never a publishing track. */
  prepareReceiveOnlyAudio(): void
  /** Creates the initial in-band server-events channel before the first
   * browser-compatible SDP offer. The Runtime never reads or publishes
   * application messages on this transport channel. */
  prepareServerEventsDataChannel(): void
  createOffer(): Promise<SessionDescriptionLike>
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>
  /** Wait until ICE/DTLS has made this PeerConnection usable by the SFU for
   * remote-track operations. */
  waitForConnection(timeoutMs: number): Promise<void>
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
    prepareReceiveOnlyAudio: () => {
      pc.addTransceiver("audio", { direction: "recvonly" })
    },
    prepareServerEventsDataChannel: () => {
      pc.createDataChannel("server-events")
    },
    createOffer: async () =>
      (await pc.createOffer()) as unknown as SessionDescriptionLike,
    setRemoteDescription: async (description) => {
      await pc.setRemoteDescription(
        description as unknown as Parameters<typeof pc.setRemoteDescription>[0]
      )
    },
    waitForConnection: async (timeoutMs) => {
      if (pc.connectionState === "connected") return
      if (pc.connectionState === "closed" || pc.connectionState === "failed")
        throw new Error("peer_connection_not_connected")
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined = undefined
        let subscription: { unSubscribe(): void } | undefined = undefined
        const finish = (result: "connected" | "failed") => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          subscription?.unSubscribe()
          if (result === "connected") resolve()
          else reject(new Error("peer_connection_not_connected"))
        }
        subscription = pc.connectionStateChange.subscribe((state) => {
          if (state === "connected") finish("connected")
          else if (state === "closed" || state === "failed") finish("failed")
        })
        timeout = setTimeout(() => {
          if (settled) return
          settled = true
          subscription?.unSubscribe()
          reject(new Error("peer_connection_connect_timeout"))
        }, timeoutMs)
        if (settled) clearTimeout(timeout)
      })
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
