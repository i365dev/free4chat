import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  docsPathFromSlug,
  flattenDocsPages,
  type DocsNavigation,
} from "../../common/docsNav"

const ROOT = process.cwd()

const docsNav = JSON.parse(
  readFileSync(join(ROOT, "../docs/en/navigation.json"), "utf-8")
) as DocsNavigation
const docsUrls = flattenDocsPages(docsNav).map(
  (page) => `https://www.free4.chat${docsPathFromSlug(page.slug)}`
)

describe("robots.txt", () => {
  const robots = readFileSync(join(ROOT, "public/robots.txt"), "utf-8")

  it("allows crawling by default", () => {
    expect(robots).toMatch(/User-agent:\s*\*/)
    expect(robots).toMatch(/Allow:\s*\//)
  })

  it("disallows the API and the Agent MCP endpoint", () => {
    expect(robots).toMatch(/Disallow:\s*\/mcp/)
    expect(robots).toMatch(/Disallow:\s*\/api\//)
  })

  it("does NOT disallow /room — it relies on a page-level noindex meta tag, which crawlers can only read if they're allowed to fetch the page", () => {
    expect(robots).not.toMatch(/Disallow:\s*\/room\b/)
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

  it("lists exactly the shipped public/discovery pages plus every docs route", () => {
    expect(new Set(locs)).toEqual(
      new Set([
        "https://www.free4.chat/",
        "https://www.free4.chat/temporary-chat-room",
        "https://www.free4.chat/ai-agent-room",
        "https://www.free4.chat/multi-agent-collaboration",
        "https://www.free4.chat/privacy",
        "https://www.free4.chat/developers/mcp",
        ...docsUrls,
      ])
    )
  })

  it("covers every docs navigation entry, so a new docs page without a sitemap entry fails here", () => {
    expect(docsUrls.length).toBeGreaterThan(1)
    for (const url of docsUrls) {
      expect(locs).toContain(url)
    }
  })

  it("never includes ephemeral room URLs, query strings, or the raw MCP API endpoint", () => {
    for (const loc of locs) {
      // Anchored to the site-root /room page: /docs/concepts/room is a
      // legitimate static docs route, ephemeral room URLs are not.
      expect(loc).not.toMatch(/^https:\/\/www\.free4\.chat\/room\b/)
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

describe("_document.tsx", () => {
  it("does not set a description meta tag (next/document renders unconditionally on every page and next/head does not dedupe plain <meta> tags, so a fallback here would duplicate each page's own description)", () => {
    const source = readFileSync(join(ROOT, "src/pages/_document.tsx"), "utf-8")
    expect(source).not.toMatch(/name="description"/)
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
