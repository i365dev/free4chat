export const AUDIO_TRACK_CONSTRAINTS: MediaTrackConstraints = {
  advanced: [
    { autoGainControl: true },
    { noiseSuppression: true },
    { echoCancellation: true },
  ],
}

export const LOCAL_PEER_ID = "local-peer"

export const GET_WORKER_URL = () => {
  return process.env.NEXT_PUBLIC_WORKER_URL || "http://localhost:8787"
}
