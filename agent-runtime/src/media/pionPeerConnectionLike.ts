import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import type {
  MediaTrackLike,
  PeerConnectionLike,
} from "./peerConnectionLike.js"
import type { SessionDescriptionLike } from "./sfuRestClient.js"

/**
 * Pion media engine adapter (#100 Phase 2): implements the narrow
 * PeerConnectionLike surface by driving the local Go/Pion child process
 * over line-delimited JSON stdio. The child owns ICE/DTLS/SRTP; this side
 * owns zero WebRTC state and performs zero Worker HTTP — authorization
 * stays in SfuMediaBridge/SfuRestClient exactly as before.
 *
 * Signaling mapping (see #101 §4: always follow the actual description
 * type, never assume):
 *   setRemoteDescription(answer) -> apply-remote{type:"answer"}
 *   setRemoteDescription(offer)  -> apply-remote{type:"offer"}, which makes
 *       the engine apply it, create and set its local answer atomically,
 *       and return that answer; createAnswer()/setLocalDescription() then
 *       replay the cached answer to keep the DOM-shaped call order intact.
 */

interface GoResponse {
  id: number
  ok: boolean
  error?: string
  offer?: SessionDescriptionLike
  answer?: SessionDescriptionLike
  mid?: string
  appliedType?: string
  counts?: Record<string, number>
}

interface GoEvent {
  ev: string
  track?: {
    kind: string
    mime: string
    clockRate: number
    channels: number
    payloadType: number
    ssrc: number
    mid: string
  }
  mid?: string
  seq?: number
  ts?: number
  payload?: string
}

export interface PionEngineOptions {
  /** Path to the compiled pion-cloudflare binary. */
  binPath?: string
  /** Diagnostic dump directory handed to the child (-dump-dir). */
  dumpDir?: string
}

const DEFAULT_BIN = join(
  process.cwd().includes("agent-runtime")
    ? join(process.cwd(), "..", "experiments", "pion-cloudflare")
    : join(process.cwd(), "experiments", "pion-cloudflare"),
  "pion-cloudflare"
)

class RtpTrack implements MediaTrackLike {
  public readonly kind = "audio" as const
  public codec?: { mimeType: string; clockRate: number; channels?: number }
  private listeners: Array<
    (packet: { payload: Uint8Array; header: { timestamp: number } }) => void
  > = []

  constructor(
    public readonly mid: string,
    mime: string,
    clockRate: number,
    channels: number
  ) {
    this.codec = {
      mimeType: mime.toLowerCase(),
      clockRate,
      ...(channels > 0 ? { channels } : {}),
    }
  }

  push(payloadB64: string, timestamp: number): void {
    const payload = Uint8Array.from(Buffer.from(payloadB64, "base64"))
    for (const listener of this.listeners)
      listener({ payload, header: { timestamp } })
  }

  get onReceiveRtp(): {
    subscribe(
      callback: (packet: {
        payload: Uint8Array
        header: { timestamp: number }
      }) => void
    ): void
  } {
    return {
      subscribe: (callback) => {
        this.listeners.push(callback)
      },
    }
  }
}

/**
 * Accumulates raw stdout chunks and emits complete newline-terminated lines.
 * Node `data` chunks carry no line-boundary guarantee (#100 Phase-2 review):
 * a long RTP event or an SDP response can span any number of chunks, and a
 * naive per-chunk split silently drops both fragments.
 */
export function createLineFramer(onLine: (line: string) => void): {
  push: (chunk: string) => void
} {
  let buffer = ""
  return {
    push(chunk: string): void {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) onLine(line)
      }
    },
  }
}

class PionChildError extends Error {}

export async function createPionPeerConnection(
  options?: PionEngineOptions
): Promise<PeerConnectionLike> {
  const binPath =
    options?.binPath ?? process.env.FREE4CHAT_PION_BIN ?? DEFAULT_BIN
  const dumpDir =
    options?.dumpDir ??
    process.env.FREE4CHAT_PION_DUMP_DIR ??
    join("/tmp/free4chat-pion", `runtime-${Date.now()}`)
  mkdirSync(dumpDir, { recursive: true })

  const child: ChildProcess = spawn(binPath, ["-dump-dir", dumpDir], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  if (!child.stdin || !child.stdout)
    throw new Error(`pion engine failed to spawn at ${binPath}`)

  let rpcId = 0
  const pending = new Map<
    number,
    { resolve: (v: GoResponse) => void; reject: (e: Error) => void }
  >()
  const tracksByMid = new Map<string, RtpTrack>()
  let trackListener: ((track: MediaTrackLike) => void) | undefined
  let cachedAnswer: SessionDescriptionLike | undefined

  const fail = (message: string) => {
    for (const entry of pending.values())
      entry.reject(new PionChildError(message))
    pending.clear()
  }

  const handleStdoutLine = (rawLine: string): void => {
    const line = rawLine.trim()
    if (!line) return
    let msg: GoResponse & GoEvent
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.ev === "ontrack" && msg.track) {
      const info = msg.track
      let track = tracksByMid.get(info.mid)
      if (!track) {
        track = new RtpTrack(info.mid, info.mime, info.clockRate, info.channels)
        tracksByMid.set(info.mid, track)
        trackListener?.(track)
      }
      return
    }
    if (msg.ev === "rtp") {
      tracksByMid
        .get(String(msg.mid))
        ?.push(String(msg.payload), Number(msg.ts))
      return
    }
    const waiter = pending.get(msg.id)
    if (waiter) {
      pending.delete(msg.id)
      if (msg.ok) {
        waiter.resolve(msg)
      } else {
        waiter.reject(new PionChildError(msg.error ?? "pion op failed"))
      }
    }
  }

  // Node `data` chunks carry no line-boundary guarantee: a long RTP event or
  // SDP response can span any number of chunks, so complete JSONL lines are
  // framed across chunk edges instead of parsing raw fragments.
  const stdoutFramer = createLineFramer((line) => handleStdoutLine(line))
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutFramer.push(chunk.toString())
  })
  child.on("exit", (code) => fail(`pion engine exited early (code=${code})`))
  child.on("error", (err) => fail(`pion engine error: ${err.message}`))

  function send(
    cmd: Record<string, unknown>,
    timeoutMs = 45000
  ): Promise<GoResponse> {
    cmd.id = ++rpcId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(Number(cmd.id))
        reject(new PionChildError(`pion op=${String(cmd.op)} timed out`))
      }, timeoutMs)
      pending.set(Number(cmd.id), {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      child.stdin!.write(JSON.stringify(cmd) + "\n")
    })
  }

  await send({ op: "init" }, 20000)

  return {
    // The engine gathers all ICE candidates before resolving create-offer.
    createOffer: async () => {
      const reply = await send({ op: "create-offer" }, 30000)
      if (!reply.offer) throw new PionChildError("engine returned no offer")
      return reply.offer
    },
    setRemoteDescription: async (description: SessionDescriptionLike) => {
      const reply = await send({
        op: "apply-remote",
        type: description.type,
        sdp: description.sdp,
      })
      if (reply.appliedType === "offer" && reply.answer) {
        // Remote OFFER: engine already answered locally; cache for the
        // bridge's subsequent createAnswer()/setLocalDescription() calls.
        cachedAnswer = reply.answer
      }
    },
    createAnswer: async () => {
      if (!cachedAnswer)
        throw new PionChildError(
          "createAnswer before a remote offer was applied"
        )
      return cachedAnswer
    },
    setLocalDescription: async () => {
      // Already applied inside apply-remote; nothing to do.
    },
    onTrack: {
      subscribe: (callback) => {
        trackListener = callback
      },
    },
    armPublishAudio: async () => {
      await send({ op: "arm-publish" })
    },
    activatePublish: async () => {
      await send({ op: "activate-publish" })
    },
    deactivatePublish: async () => {
      send({ op: "deactivate-publish" }).catch(() => undefined)
    },
    cancelTurnAudio: async () => {
      await send({ op: "cancel-turn" })
    },
    flushAudio: async () => {
      await send({ op: "flush-audio" }, 30_000)
    },
    localPublishMid: async () => {
      const reply = await send({ op: "local-mid" })
      return reply.mid || undefined
    },
    writePcmChunk: async (chunk) => {
      await send(
        { op: "write-pcm", payload: Buffer.from(chunk).toString("base64") },
        30_000
      )
    },
    publishStats: async () => {
      const reply = await send({ op: "publish-stats" })
      const counts = reply.counts ?? {}
      const number = (key: string): number =>
        typeof counts[key] === "number" ? Number(counts[key]) : 0
      return {
        pcm_write_calls: number("pcm_write_calls"),
        pcm_input_bytes: number("pcm_input_bytes"),
        opus_frames_written: number("opus_frames_written"),
        ...(typeof counts.outbound_rtp_packets === "number"
          ? { outbound_rtp_packets: number("outbound_rtp_packets") }
          : {}),
        ...(typeof counts.outbound_rtp_bytes === "number"
          ? { outbound_rtp_bytes: number("outbound_rtp_bytes") }
          : {}),
      }
    },
    close: () => {
      try {
        child.stdin?.write(JSON.stringify({ id: ++rpcId, op: "close" }) + "\n")
      } catch {
        // Child may already be gone.
      }
      setTimeout(() => child.kill("SIGKILL"), 2000)
    },
  }
}
