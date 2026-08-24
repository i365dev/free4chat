import assert from "node:assert/strict"
import { test } from "node:test"

import { createLineFramer } from "../src/media/pionPeerConnectionLike.js"

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
