export const SFU_EGRESS_SAMPLE_INTERVAL_MS = 5 * 60 * 1000

export type SfuEgressSampleReason =
  | "interval"
  | "leave"
  | "pagehide"
  | "disconnect"

export interface SfuEgressBytes {
  audioBytes: number
  videoBytes: number
  dataChannelBytes: number
}

export interface SfuEgressSample extends SfuEgressBytes {
  totalBytes: number
  intervalMs: number
  sampleReason: SfuEgressSampleReason
}

const EMPTY_BYTES: SfuEgressBytes = {
  audioBytes: 0,
  videoBytes: 0,
  dataChannelBytes: 0,
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return 0
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
}

function addBytes(current: number, value: unknown): number {
  const next = current + nonNegativeInteger(value)
  return Math.min(next, Number.MAX_SAFE_INTEGER)
}

function eachStat(
  report: unknown,
  callback: (stat: Record<string, unknown>) => void
) {
  if (!report || typeof report !== "object") return

  const record = report as Record<string, unknown>
  if (typeof record.type === "string") {
    callback(record)
    return
  }

  const candidate = report as {
    forEach?: (callback: (value: unknown) => void) => void
    values?: () => Iterable<unknown>
  }
  if (typeof candidate.forEach === "function") {
    candidate.forEach((value) => {
      if (value && typeof value === "object")
        callback(value as Record<string, unknown>)
    })
    return
  }
  if (typeof candidate.values === "function") {
    for (const value of candidate.values()) {
      if (value && typeof value === "object")
        callback(value as Record<string, unknown>)
    }
    return
  }
  if (Symbol.iterator in report) {
    for (const value of report as Iterable<unknown>) {
      if (value && typeof value === "object")
        callback(value as Record<string, unknown>)
    }
    return
  }
  for (const value of Object.values(report)) {
    if (value && typeof value === "object")
      callback(value as Record<string, unknown>)
  }
}

/** Aggregate only browser-observed Cloudflare -> browser counters. */
export function aggregateSfuEgressStats(report: unknown): SfuEgressBytes {
  const bytes = { ...EMPTY_BYTES }
  eachStat(report, (stat) => {
    const type = stat.type
    const received = stat.bytesReceived
    if (type === "inbound-rtp") {
      const kind = stat.kind ?? stat.mediaType
      if (kind === "audio")
        bytes.audioBytes = addBytes(bytes.audioBytes, received)
      else if (kind === "video")
        bytes.videoBytes = addBytes(bytes.videoBytes, received)
    } else if (type === "data-channel") {
      bytes.dataChannelBytes = addBytes(bytes.dataChannelBytes, received)
    }
  })
  return bytes
}

/** Return a non-negative delta, or null when a counter needs re-baselining. */
export function sfuEgressDelta(
  previous: SfuEgressBytes | null,
  current: SfuEgressBytes
): SfuEgressBytes | null {
  if (!previous) return null
  if (
    current.audioBytes < previous.audioBytes ||
    current.videoBytes < previous.videoBytes ||
    current.dataChannelBytes < previous.dataChannelBytes
  )
    return null
  return {
    audioBytes: current.audioBytes - previous.audioBytes,
    videoBytes: current.videoBytes - previous.videoBytes,
    dataChannelBytes: current.dataChannelBytes - previous.dataChannelBytes,
  }
}

function totalBytes(bytes: SfuEgressBytes): number {
  return Math.min(
    bytes.audioBytes + bytes.videoBytes + bytes.dataChannelBytes,
    Number.MAX_SAFE_INTEGER
  )
}

type StatsSource = () => PromiseLike<unknown> | unknown

export interface SfuEgressSampler {
  sample(
    source: unknown,
    getStats: StatsSource,
    reason: SfuEgressSampleReason
  ): void
}

/**
 * Keep WebRTC stats accounting local to one browser session. Sampling is
 * asynchronous and best-effort; errors are deliberately swallowed so an
 * analytics problem can never affect Room or media behavior.
 */
export function createSfuEgressSampler(
  emit: (sample: SfuEgressSample, source: unknown) => void,
  now: () => number = () => Date.now()
): SfuEgressSampler {
  let source: unknown = undefined
  let previous: SfuEgressBytes | null = null
  let lastObservedAt: number | null = null
  let pending: Promise<void> | null = null

  const run = (
    nextSource: unknown,
    getStats: StatsSource,
    reason: SfuEgressSampleReason
  ): Promise<void> => {
    if (source !== nextSource) {
      source = nextSource
      previous = null
      lastObservedAt = null
    }

    let report: PromiseLike<unknown> | unknown
    try {
      // Call getStats before the caller can close the PeerConnection during a
      // best-effort leave/pagehide cleanup.
      report = getStats()
    } catch {
      return Promise.resolve()
    }

    return Promise.resolve(report)
      .then((value) => {
        const current = aggregateSfuEgressStats(value)
        const observedAt = now()
        const delta = sfuEgressDelta(previous, current)
        const intervalMs =
          lastObservedAt === null ? 0 : Math.max(0, observedAt - lastObservedAt)
        previous = current
        lastObservedAt = observedAt
        if (!delta || totalBytes(delta) === 0) return
        try {
          emit(
            {
              ...delta,
              totalBytes: totalBytes(delta),
              intervalMs,
              sampleReason: reason,
            },
            nextSource
          )
        } catch {
          // Analytics must never block the product flow.
        }
      })
      .catch(() => {
        // getStats() is not uniformly available or reliable across browsers.
      })
  }

  return {
    sample(nextSource, getStats, reason) {
      const runNext = () => run(nextSource, getStats, reason)
      const next = pending ? pending.then(runNext, runNext) : runNext()
      let settled: Promise<void>
      settled = next.finally(() => {
        if (pending === settled) pending = null
      })
      pending = settled
    },
  }
}
