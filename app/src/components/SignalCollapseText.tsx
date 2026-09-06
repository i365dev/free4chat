import { useEffect, useLayoutEffect, useState } from "react"

const NOISE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+-=/<>?[]{}:;@|_"
const TICK_MS = 34
const COLLAPSE_MS = 1180
const LINE_DELAY_MS = 90
const UINT32_RANGE = 0x100000000

const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

type Phase = "idle" | "active" | "resolved"

interface SignalCollapseTextProps {
  text: string
  className?: string
}

const unit = (value: number) => value / UINT32_RANGE

const isStableWhitespace = (char: string) => /\s/.test(char)

/**
 * A one-shot, client-only signal-acquisition effect.
 *
 * The server and initial client render always contain the final text. After
 * hydration, each non-whitespace glyph samples fresh crypto-backed noise and
 * an increasing probability of permanently locking to its target character.
 * Every run takes a different path through a very large random state space,
 * while the final message is deterministic.
 */
export default function SignalCollapseText({
  text,
  className = "",
}: SignalCollapseTextProps) {
  const [displayText, setDisplayText] = useState(text)
  const [phase, setPhase] = useState<Phase>("idle")

  useClientLayoutEffect(() => {
    const reducedMotion = window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false

    if (reducedMotion || !window.crypto?.getRandomValues) {
      setDisplayText(text)
      setPhase("idle")
      return
    }

    const chars = Array.from(text)
    const locked = chars.map(isStableWhitespace)
    const lineByIndex: number[] = []
    let line = 0

    for (const char of chars) {
      lineByIndex.push(line)
      if (char === "\n") line += 1
    }

    // Each glyph receives a different convergence center so the message locks
    // spatially rather than revealing from left to right.
    const biasWords = new Uint32Array(chars.length)
    window.crypto.getRandomValues(biasWords)
    const collapseBias = Array.from(
      biasWords,
      (value) => 0.44 + unit(value) * 0.24
    )

    const initialNoise = new Uint32Array(chars.length)
    window.crypto.getRandomValues(initialNoise)
    setDisplayText(
      chars
        .map((char, index) =>
          isStableWhitespace(char)
            ? char
            : NOISE_GLYPHS[initialNoise[index] % NOISE_GLYPHS.length]
        )
        .join("")
    )
    setPhase("active")

    const startedAt = window.performance.now()
    let previousAt = startedAt

    const timer = window.setInterval(() => {
      const now = window.performance.now()
      const deltaSeconds = Math.min(0.08, (now - previousAt) / 1000)
      previousAt = now

      // Three independent samples per glyph: lock, transient target glimpse,
      // and replacement noise.
      const randomWords = new Uint32Array(chars.length * 3)
      window.crypto.getRandomValues(randomWords)

      const next = chars.map((target, index) => {
        if (locked[index]) return target

        const elapsed = now - startedAt - lineByIndex[index] * LINE_DELAY_MS
        const sampleOffset = index * 3

        if (elapsed <= 0) {
          return NOISE_GLYPHS[
            randomWords[sampleOffset + 2] % NOISE_GLYPHS.length
          ]
        }

        const progress = Math.max(0, Math.min(1, elapsed / COLLAPSE_MS))

        // A sigmoid raises the lock hazard sharply around a per-glyph random
        // center. Converting hazard to a delta-time probability keeps the
        // process approximately independent of timer cadence.
        const signal =
          1 / (1 + Math.exp(-12 * (progress - collapseBias[index])))
        const lockHazard = 0.08 + 20 * signal * signal
        const lockProbability =
          1 - Math.exp(-lockHazard * Math.max(deltaSeconds, 0.001))

        if (
          progress >= 0.985 ||
          unit(randomWords[sampleOffset]) < lockProbability
        ) {
          locked[index] = true
          return target
        }

        // Before permanent lock, the real glyph becomes increasingly likely
        // to flash through the noise, like a weak signal gaining confidence.
        const targetGlimpseProbability = 0.03 + 0.62 * progress * progress

        if (unit(randomWords[sampleOffset + 1]) < targetGlimpseProbability) {
          return target
        }

        return NOISE_GLYPHS[randomWords[sampleOffset + 2] % NOISE_GLYPHS.length]
      })

      if (locked.every(Boolean)) {
        window.clearInterval(timer)
        setDisplayText(text)
        setPhase("resolved")
        return
      }

      setDisplayText(next.join(""))
    }, TICK_MS)

    return () => window.clearInterval(timer)
  }, [text])

  const classes = [
    "signal-collapse-text",
    `signal-collapse-text--${phase}`,
    className,
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <span aria-hidden="true" className={classes}>
      {displayText}
    </span>
  )
}
