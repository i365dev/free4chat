import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const ROOT = process.cwd()

describe("robots.txt", () => {
  const robots = readFileSync(join(ROOT, "public/robots.txt"), "utf-8")

  it("allows crawling by default", () => {
    expect(robots).toMatch(/User-agent:\s*\*/)
    expect(robots).toMatch(/Allow:\s*\//)
  })

  it("disallows ephemeral room URLs, the API, and the Agent MCP endpoint", () => {
    expect(robots).toMatch(/Disallow:\s*\/room/)
    expect(robots).toMatch(/Disallow:\s*\/mcp/)
    expect(robots).toMatch(/Disallow:\s*\/api\//)
  })

  it("points to the sitemap", () => {
    expect(robots).toMatch(
      /Sitemap:\s*https:\/\/www\.free4\.chat\/sitemap\.xml/
    )
  })
})

describe("sitemap.xml", () => {
  const sitemap = readFileSync(join(ROOT, "public/sitemap.xml"), "utf-8")
  const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])

  it("is well-formed XML with at least one URL", () => {
    expect(sitemap).toMatch(/^<\?xml/)
    expect(sitemap).toContain("<urlset")
    expect(locs.length).toBeGreaterThan(0)
  })

  it("lists exactly the shipped public/discovery pages", () => {
    expect(new Set(locs)).toEqual(
      new Set([
        "https://www.free4.chat/",
        "https://www.free4.chat/temporary-chat-room",
        "https://www.free4.chat/ai-agent-room",
        "https://www.free4.chat/privacy",
        "https://www.free4.chat/developers/mcp",
      ])
    )
  })

  it("never includes ephemeral room URLs, query strings, or the raw MCP API endpoint", () => {
    for (const loc of locs) {
      expect(loc).not.toMatch(/\/room\b/)
      expect(loc).not.toContain("?")
      expect(loc).not.toBe("https://www.free4.chat/mcp")
    }
  })

  it("never includes unshipped future-feature pages", () => {
    const unshipped = [
      "voice-agent",
      "meeting-notes",
      "agent-games",
      "live-translation",
    ]
    for (const loc of locs) {
      for (const slug of unshipped) {
        expect(loc).not.toContain(slug)
      }
    }
  })
})

describe("Future/unshipped discovery pages are not present", () => {
  const unshippedRoutes = [
    "voice-agent.tsx",
    "meeting-notes.tsx",
    "agent-games.tsx",
    "live-translation.tsx",
    "private-voice-chat.tsx",
  ]

  it.each(unshippedRoutes)("src/pages/%s does not exist yet", (file) => {
    expect(existsSync(join(ROOT, "src/pages", file))).toBe(false)
  })
})
