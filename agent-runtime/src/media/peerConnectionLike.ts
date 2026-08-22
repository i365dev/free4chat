import type { SessionDescriptionLike } from "./sfuRestClient.js"

export interface RtpPacketLike {
  payload: Uint8Array
  header: { timestamp: number }
}

export interface MediaTrackLike {
  kind: "audio" | "video"
  onReceiveRtp: { subscribe(callback: (packet: RtpPacketLike) => void): void }
}

/**
 * The subset of werift's RTCPeerConnection this module depends on, kept as
 * a narrow interface so unit tests can inject a deterministic fake instead
 * of a real WebRTC/ICE/DTLS stack.
 */
export interface PeerConnectionLike {
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
  const pc = new RTCPeerConnection({})
  return {
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
      subscribe: (callback) =>
        pc.onTrack.subscribe(
          callback as unknown as (...args: unknown[]) => void
        ),
    },
    close: () => pc.close(),
  }
}
