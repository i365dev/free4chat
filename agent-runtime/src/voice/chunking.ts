/**
 * Phrase/sentence chunking for outbound Agent voice (#83 vertical slice).
 * Harness response text arrives as one blob; coherent chunks let TTS start
 * before the whole answer is synthesized while keeping prosody natural.
 * Pure and deterministic: no I/O, no locale-aware segmentation, no state
 * beyond the buffered remainder between push() calls.
 */

export interface TextChunkerOptions {
  /** Soft maximum per chunk before clause-level emergency splitting. */
  maxChars?: number
}

export interface TextChunker {
  /** Feeds text and returns every chunk now known to be complete. */
  push(text: string): string[]
  /** Emits whatever coherent remainder is still buffered, then resets. */
  flush(): string[]
}

export const DEFAULT_MAX_CHUNK_CHARS = 240

const SENTENCE_ENDERS = new Set([
  ".",
  "!",
  "?",
  "…",
  "。",
  "！",
  "？",
  "；",
  ";",
])

/** Characters that may trail a sentence terminator inside one spoken unit. */
const CLOSERS = new Set([
  '"',
  "'",
  ")",
  "]",
  "}",
  "」",
  "』",
  "》",
  "»",
  "”",
  "’",
  "…",
])

/** Preferred break points for overlong runs without any sentence ender. */
const CLAUSE_BREAKS = new Set([",", "，", "、", ":", "："])

/** Full-width terminators close a sentence on their own — written CJK has
 * no spaces, so requiring trailing whitespace would never split. */
const UNCONDITIONAL_ENDERS = new Set(["。", "！", "？", "；", "…"])

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9"
}

interface Extraction {
  chunks: string[]
}

export function createTextChunker(options?: TextChunkerOptions): TextChunker {
  const maxChars = Math.max(1, options?.maxChars ?? DEFAULT_MAX_CHUNK_CHARS)
  let buffer = ""

  function extract(final: boolean): Extraction {
    const chunks: string[] = []
    let start = 0
    let searchFrom = start
    for (;;) {
      const length = buffer.length - start
      if (length <= 0) break
      let boundaryEnd = -1
      let resumeAt = -1
      for (let i = searchFrom; i < buffer.length; i += 1) {
        const ch = buffer[i]
        if (ch === "\n") {
          boundaryEnd = i
          resumeAt = i + 1
          break
        }
        const isEnder = SENTENCE_ENDERS.has(ch)
        if (
          isEnder &&
          ch === "." &&
          i > start &&
          isDigit(buffer[i - 1]) &&
          isDigit(buffer[i + 1] ?? "")
        )
          continue
        if (!isEnder) continue
        let end = i + 1
        while (end < buffer.length) {
          const next = buffer[end]
          if (!CLOSERS.has(next) && !SENTENCE_ENDERS.has(next)) break
          end += 1
        }
        if (end < buffer.length) {
          const unconditional = UNCONDITIONAL_ENDERS.has(ch)
          const followedBySpace = buffer[end] === " " || buffer[end] === "\t"
          if (!unconditional && !followedBySpace) {
            searchFrom = i + 1
            continue
          }
          boundaryEnd = end
          resumeAt = end
        } else if (final) {
          boundaryEnd = end
          resumeAt = end
        } else {
          searchFrom = i + 1
          continue
        }
        break
      }
      if (boundaryEnd < 0 && length > maxChars) {
        const windowEnd = start + maxChars
        let clauseBreak = -1
        for (let i = start; i < windowEnd && i < buffer.length; i += 1)
          if (CLAUSE_BREAKS.has(buffer[i])) clauseBreak = i
        if (clauseBreak >= 0) {
          boundaryEnd = clauseBreak + 1
          resumeAt = boundaryEnd
        } else {
          boundaryEnd = windowEnd
          resumeAt = windowEnd
        }
      }
      if (boundaryEnd < 0) break
      const raw = buffer.slice(start, boundaryEnd)
      const chunk = raw.trim()
      if (chunk) chunks.push(chunk)
      start = resumeAt
      while (start < buffer.length && /\s/.test(buffer[start])) start += 1
      searchFrom = start
    }
    buffer = buffer.slice(start)
    return { chunks }
  }

  return {
    push(text: string): string[] {
      if (text) buffer += text
      return extract(false).chunks
    },
    flush(): string[] {
      const result = extract(true).chunks
      if (buffer.trim()) result.push(buffer.trim())
      buffer = ""
      return result
    },
  }
}
