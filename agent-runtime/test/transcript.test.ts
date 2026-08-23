import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MeetingTranscriptStore,
  recordCommittedTranscriptEvent,
} from "../src/speech/transcript.js"

test("meeting transcript stores committed attributed speech and cleans up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-transcript-"))
  const path = join(directory, ".meeting-notes", "transcript.jsonl")
  const store = new MeetingTranscriptStore(path)
  try {
    await store.ready()
    const source = {
      participantId: "human-1",
      participantName: "Alice",
      trackName: "mic",
    }
    recordCommittedTranscriptEvent(store, {
      source,
      event: { type: "partial", text: "The launch is Fr" },
    })
    recordCommittedTranscriptEvent(store, {
      source,
      event: { type: "error", error: { code: "provider", message: "no" } },
    })
    recordCommittedTranscriptEvent(store, {
      source,
      event: { type: "committed", text: "The launch is Friday." },
    })
    await store.flush()
    assert.deepEqual(store.snapshot().segments, [
      {
        participantId: "human-1",
        speaker: "Alice",
        text: "The launch is Friday.",
      },
    ])
    assert.match(await readFile(path, "utf8"), /The launch is Friday\./)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    await store.dispose()
    assert.rejects(stat(path))
    await rm(directory, { recursive: true, force: true })
  }
})
