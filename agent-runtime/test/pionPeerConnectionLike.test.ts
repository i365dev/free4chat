import assert from "node:assert/strict"
import { test } from "node:test"

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createLineFramer,
  createPionPeerConnection,
} from "../src/media/pionPeerConnectionLike.js"

test("frames a JSONL event split across three chunks", () => {
  const seen: string[] = []
  const framer = createLineFramer((line) => seen.push(line))
  framer.push('{"ev":"rtp","mid":"1","pay')
  framer.push('load":"AAAA","ts":123}')
  framer.push("\n")
  assert.deepEqual(seen, ['{"ev":"rtp","mid":"1","payload":"AAAA","ts":123}'])
})

test("frames multiple lines arriving in one chunk", () => {
  const seen: string[] = []
  const framer = createLineFramer((line) => seen.push(line))
  framer.push('{"a":1}\n{"b":2}\n{"c":3}\n')
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}'])
})

test("keeps the trailing partial line for the next chunk", () => {
  const seen: string[] = []
  const framer = createLineFramer((line) => seen.push(line))
  framer.push('{"x":1}\n{"y"')
  assert.deepEqual(seen, ['{"x":1}'])
  framer.push(":2}\n")
  assert.deepEqual(seen, ['{"x":1}', '{"y":2}'])
})

test("drops empty lines but preserves interior whitespace of payloads", () => {
  const seen: string[] = []
  const framer = createLineFramer((line) => seen.push(line))
  framer.push('\n\n{"p":"a b  c"}\n\n')
  assert.deepEqual(seen, ['{"p":"a b  c"}'])
})

// A scripted stand-in for the Go child that records every JSONL command it
// receives and answers each op the way the real engine does. This proves the
// ADAPTER's command/data flow (spawn, framing, id correlation, base64 PCM)
// deterministically — no ICE, no network, unlike fake PeerConnectionLike
// bridges which bypass this file entirely.
const FAKE_ENGINE = `#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const dumpDir = process.argv[process.argv.indexOf("-dump-dir") + 1]
const tracePath = path.join(dumpDir, "commands.jsonl")
let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk.toString()
  for (;;) {
    const i = buf.indexOf("\\n")
    if (i < 0) break
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    fs.appendFileSync(tracePath, line + "\\n")
    const cmd = JSON.parse(line)
    const reply = { id: cmd.id, ok: true }
    switch (cmd.op) {
      case "create-offer":
        reply.offer = { type: "offer", sdp: "v=0 fake-offer" }
        break
      case "apply-remote":
        reply.appliedType = cmd.type
        break
      case "local-mid":
        reply.mid = "pub-mid-7"
        break
      case "close":
        process.exit(0)
      default:
        break
    }
    process.stdout.write(JSON.stringify(reply) + "\\n")
  }
})
`

test("adapter drives the child's publish JSONL protocol end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pion-adapter-"))
  const binPath = join(dir, "fake-pion-engine.mjs")
  writeFileSync(binPath, FAKE_ENGINE)
  chmodSync(binPath, 0o755)

  try {
    const pc = await createPionPeerConnection({ binPath, dumpDir: dir })

    const offer = await pc.createOffer()
    assert.equal(offer.type, "offer")
    assert.equal(offer.sdp, "v=0 fake-offer")

    await pc.setRemoteDescription({ type: "answer", sdp: "v=0 fake-answer" })
    await pc.armPublishAudio!()
    assert.equal(await pc.localPublishMid!(), "pub-mid-7")
    await pc.activatePublish!()

    // Odd-sized chunk proves the payload survives base64 round-trip exactly.
    const chunkA = Uint8Array.from([1, 2, 3])
    const chunkB = Uint8Array.from([9, 8, 7, 6, 5])
    await pc.writePcmChunk!(chunkA)
    await pc.writePcmChunk!(chunkB)

    await pc.flushAudio!()
    await pc.deactivatePublish!()
    pc.close()

    await new Promise((resolve) => setTimeout(resolve, 100))
    const commands = readFileSync(join(dir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string; payload?: string })
    assert.deepEqual(
      commands.map((cmd) => cmd.op),
      [
        "init",
        "create-offer",
        "apply-remote",
        "arm-publish",
        "local-mid",
        "activate-publish",
        "write-pcm",
        "write-pcm",
        "flush-audio",
        "deactivate-publish",
        "close",
      ]
    )
    const written = commands.filter((cmd) => cmd.op === "write-pcm")
    assert.deepEqual(
      Buffer.from(written[0]!.payload!, "base64"),
      Buffer.from(chunkA)
    )
    assert.deepEqual(
      Buffer.from(written[1]!.payload!, "base64"),
      Buffer.from(chunkB)
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
