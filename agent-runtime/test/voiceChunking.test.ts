import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createTextChunker,
  DEFAULT_MAX_CHUNK_CHARS,
} from "../src/voice/chunking.js"

test("chunker splits complete english sentences and keeps the remainder buffered", () => {
  const chunker = createTextChunker()
  assert.deepEqual(chunker.push("Hello there. How are you? I"), [
    "Hello there.",
    "How are you?",
  ])
  assert.deepEqual(chunker.flush(), ["I"])
})

test("chunker splits CJK sentence terminators", () => {
  const chunker = createTextChunker()
  const chunks = [
    ...chunker.push("你好。今天天气不错！我们走吧？"),
    ...chunker.flush(),
  ]
  assert.deepEqual(chunks, ["你好。", "今天天气不错！", "我们走吧？"])
})

test("chunker treats newlines as hard breaks without speaking them", () => {
  const chunker = createTextChunker()
  const chunks = [
    ...chunker.push("first line\nsecond line\n\nclosed."),
    ...chunker.flush(),
  ]
  assert.deepEqual(chunks, ["first line", "second line", "closed."])
})

test("chunker does not split decimals", () => {
  const chunker = createTextChunker()
  const chunks = [...chunker.push("Pi is 3.14 exactly."), ...chunker.flush()]
  assert.deepEqual(chunks, ["Pi is 3.14 exactly."])
})

test("chunker keeps closing quotes with their sentence", () => {
  const chunker = createTextChunker()
  const chunks = [
    ...chunker.push('He said "Run now!" Then left. Done.'),
    ...chunker.flush(),
  ]
  assert.deepEqual(chunks, ['He said "Run now!"', "Then left.", "Done."])
})

test("chunker groups consecutive terminators into one boundary", () => {
  const chunker = createTextChunker()
  const chunks = [...chunker.push("What?! Really?! ok."), ...chunker.flush()]
  assert.deepEqual(chunks, ["What?!", "Really?!", "ok."])
})

test("chunker emits nothing for empty or whitespace-only input", () => {
  const chunker = createTextChunker()
  assert.deepEqual(chunker.push(""), [])
  assert.deepEqual(chunker.push("   \n  \n"), [])
  assert.deepEqual(chunker.flush(), [])
})

test("chunker accumulates across pushes until a boundary arrives", () => {
  const chunker = createTextChunker()
  assert.deepEqual(chunker.push("Hel"), [])
  assert.deepEqual(chunker.push("lo."), [])
  assert.deepEqual(chunker.push(" World"), ["Hello."])
  assert.deepEqual(chunker.flush(), ["World"])
})

test("chunker emergency-splits overlong clauses at clause breaks", () => {
  const chunker = createTextChunker({ maxChars: 12 })
  const text = "one, two, three, four, five, six, seven"
  const chunks = [...chunker.push(text), ...chunker.flush()]
  assert.deepEqual(chunks, ["one, two,", "three, four,", "five, six,", "seven"])
})

test("chunker hard-cuts when not even a clause break fits the window", () => {
  const maxChars = 10
  const chunker = createTextChunker({ maxChars })
  const chunks = [
    ...chunker.push("abcdefghij klmnopqrst uvwxyz"),
    ...chunker.flush(),
  ]
  assert.deepEqual(chunks, ["abcdefghij", "klmnopqrst", "uvwxyz"])
})

test("default max chars is generous enough to avoid mid-sentence cuts", () => {
  assert.ok(DEFAULT_MAX_CHUNK_CHARS >= 120)
})
