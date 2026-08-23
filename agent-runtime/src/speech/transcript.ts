import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { AudioSource } from "../media/types.js"
import type { AttributedSttEvent } from "./transcriber.js"

const MAX_SEGMENTS = 500
const MAX_TEXT_CHARS = 64_000

export interface MeetingTranscriptSegment {
  participantId: string
  speaker: string
  text: string
}

export interface MeetingTranscriptSnapshot {
  path: string
  segments: MeetingTranscriptSegment[]
}

/**
 * Runtime-local, bounded Meeting Notes memory.
 *
 * Only provider `committed` events enter this store. Raw audio, partials,
 * provider errors, participant handles, and credentials never do. The file
 * lives in the per-instance 0700 workspace's hidden meeting-notes directory
 * and is removed when disposed. The daemon creates one workspace per room
 * join, so this memory is never shared across rooms.
 */
export class MeetingTranscriptStore {
  private readonly segments: MeetingTranscriptSegment[] = []
  private writeQueue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(readonly path: string) {}

  async ready(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(this.path, "", { encoding: "utf8", mode: 0o600 })
    await chmod(this.path, 0o600)
  }

  record(source: AudioSource, text: string): void {
    if (this.disposed) return
    const normalized = text.trim()
    if (!normalized) return
    this.segments.push({
      participantId: source.participantId,
      speaker: source.participantName,
      text: normalized,
    })
    while (
      this.segments.length > MAX_SEGMENTS ||
      totalTextChars(this.segments) > MAX_TEXT_CHARS
    )
      this.segments.shift()
    this.queueWrite()
  }

  snapshot(): MeetingTranscriptSnapshot {
    return {
      path: this.path,
      segments: this.segments.map((segment) => ({ ...segment })),
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.writeQueue.catch(() => undefined)
    await rm(this.path, { force: true }).catch(() => undefined)
  }

  private queueWrite(): void {
    const contents = this.segments
      .map((segment) => JSON.stringify(segment))
      .join("\n")
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await writeFile(this.path, contents ? `${contents}\n` : "", {
          encoding: "utf8",
          mode: 0o600,
        })
        await chmod(this.path, 0o600)
      })
  }
}

function totalTextChars(segments: MeetingTranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0)
}

export function recordCommittedTranscriptEvent(
  store: MeetingTranscriptStore,
  attributed: AttributedSttEvent
): void {
  if (attributed.event.type !== "committed") return
  store.record(attributed.source, attributed.event.text)
}
