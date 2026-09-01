import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  buildDocsStaticPaths,
  buildDocsStaticProps,
  listDocsMarkdownSlugs,
  loadDocsNavigation,
} from "../../common/docsContent.server"
import {
  DOCS_ROOT_PATH,
  docsPathFromSlug,
  flattenDocsPages,
  resolveDocHref,
  type DocsNavigation,
} from "../../common/docsNav"

const ROOT = process.cwd()
const SITE_ORIGIN = "https://www.free4.chat"

const nav: DocsNavigation = loadDocsNavigation()
const pages = flattenDocsPages(nav)

describe("docs navigation", () => {
  it("has a unique slug and title for every page (unique <title> + canonical URLs)", () => {
    const slugs = pages.map((page) => page.slug)
    const titles = pages.map((page) => page.title)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(new Set(titles).size).toBe(titles.length)
    for (const page of pages) {
      expect(page.title.trim()).not.toBe("")
      expect(page.description.trim()).not.toBe("")
    }
  })

  it("resolves every navigation entry to real Markdown (navigation -> filesystem)", () => {
    for (const page of pages) {
      const result = buildDocsStaticProps(
        page.slug === "" ? [] : page.slug.split("/")
      )
      if (!("props" in result)) {
        throw new Error(`navigation entry not resolvable: ${page.slug}`)
      }
      expect(result.props.title).toBe(page.title)
      expect(result.props.description).toBe(page.description)
    }
  })

  it("represents every Markdown file in navigation (filesystem -> navigation)", () => {
    expect(listDocsMarkdownSlugs().sort()).toEqual(
      pages.map((page) => page.slug).sort()
    )
  })

  it("keeps locale content in docs/en only (no fake translated pages)", () => {
    expect(nav.locale).toBe("en")
    expect(
      listDocsMarkdownSlugs().every((slug) => !slug.startsWith("zh"))
    ).toBe(true)
  })
})

describe("docs static generation", () => {
  it("enumerates every navigation route at build time with fallback: false", () => {
    const staticPaths = buildDocsStaticPaths()
    expect(staticPaths.fallback).toBe(false)
    expect(staticPaths.paths).toHaveLength(pages.length)
    const pathSlugs = staticPaths.paths.map((path) =>
      (path.params.slug ?? []).join("/")
    )
    expect(new Set(pathSlugs)).toEqual(new Set(pages.map((page) => page.slug)))
    expect(pathSlugs).toContain("")
  })

  it("renders the docs root from index.md with canonical metadata", () => {
    const result = buildDocsStaticProps([])
    if (!("props" in result)) throw new Error("docs root must resolve")
    expect(result.props.canonicalPath).toBe(DOCS_ROOT_PATH)
    expect(result.props.source).toContain("# What is Free4Chat?")
    expect(result.props.title).toBe(nav.home.title)
    expect(result.props.prev).toBeNull()
    expect(result.props.next?.href).toBe(docsPathFromSlug(pages[1].slug))
  })

  it("renders nested routes with prev/next following navigation order", () => {
    const slug = "concepts/room"
    const result = buildDocsStaticProps(slug.split("/"))
    if (!("props" in result)) throw new Error(`${slug} must resolve`)
    expect(result.props.canonicalPath).toBe(`${DOCS_ROOT_PATH}/${slug}`)
    expect(result.props.source).toContain("# Rooms and ownership")
    const order = pages.map((page) => page.slug)
    const index = order.indexOf(slug)
    expect(result.props.prev?.href).toBe(docsPathFromSlug(order[index - 1]))
    expect(result.props.next?.href).toBe(docsPathFromSlug(order[index + 1]))
  })

  it("produces unique canonical paths for every route", () => {
    const canonicals = pages.map((page) => {
      const result = buildDocsStaticProps(
        page.slug === "" ? [] : page.slug.split("/")
      )
      if (!("props" in result)) throw new Error(`unresolvable: ${page.slug}`)
      return result.props.canonicalPath
    })
    expect(new Set(canonicals).size).toBe(canonicals.length)
    expect(canonicals.every((path) => path.startsWith("/docs"))).toBe(true)
  })

  it("fails closed on path traversal and unknown slugs, even for internally generated paths", () => {
    for (const parts of [
      ["..", ".."],
      ["..", "agent-runtime", "node-reference"],
      ["....", ".."],
      ["getting-started", "..", "..", "secrets"],
      ["does-not-exist"],
    ]) {
      expect(buildDocsStaticProps(parts)).toEqual({ notFound: true })
    }
    expect(buildDocsStaticProps(undefined)).not.toEqual({ notFound: true })
    expect(buildDocsStaticProps(["concepts", "room.md"])).toEqual({
      notFound: true,
    })
  })

  it("resolves relative Markdown links against the current page directory", () => {
    expect(resolveDocHref("shared-context", ["concepts", "room"])).toBe(
      "/docs/concepts/shared-context"
    )
    expect(
      resolveDocHref("../guides/live-transcript", ["concepts", "room"])
    ).toBe("/docs/guides/live-transcript")
    expect(resolveDocHref("getting-started/browser-room", [])).toBe(
      "/docs/getting-started/browser-room"
    )
    expect(resolveDocHref("/agent.md", [])).toBe("/agent.md")
    expect(resolveDocHref("https://www.free4.chat/", [])).toBe(
      "https://www.free4.chat/"
    )
    expect(resolveDocHref("#section", ["concepts", "room"])).toBe("#section")
  })
})

describe("llms.txt", () => {
  const llms = readFileSync(join(ROOT, "public/llms.txt"), "utf-8")

  it("identifies Free4Chat with the canonical sentence", () => {
    expect(llms).toContain(
      "Free4Chat is a temporary collaboration fabric for Humans and independently running Agents."
    )
  })

  it("links the docs, the full corpus, the developer page, the machine contracts, and the repository", () => {
    for (const link of [
      `${SITE_ORIGIN}/docs`,
      `${SITE_ORIGIN}/llms-full.txt`,
      `${SITE_ORIGIN}/developers/mcp`,
      `${SITE_ORIGIN}/agent.md`,
      `${SITE_ORIGIN}/speech.md`,
      "https://github.com/i365dev/free4chat",
    ]) {
      expect(llms).toContain(`(${link})`)
    }
  })

  it("links every docs navigation page", () => {
    for (const page of pages) {
      expect(llms).toContain(`(${SITE_ORIGIN}${docsPathFromSlug(page.slug)})`)
    }
  })
})

describe("llms-full.txt", () => {
  const corpus = readFileSync(join(ROOT, "public/llms-full.txt"), "utf-8")

  it("contains every English docs page with its canonical URL and source path", () => {
    for (const page of pages) {
      const url = `${SITE_ORIGIN}${docsPathFromSlug(page.slug)}`
      expect(corpus).toContain(`Canonical URL: ${url}`)
      expect(corpus).toContain(
        `Source: docs/en/${page.slug === "" ? "index" : page.slug}.md`
      )
    }
  })

  it("embeds the full current content of every source Markdown file", () => {
    for (const page of pages) {
      const file =
        page.slug === "" ? "docs/en/index.md" : `docs/en/${page.slug}.md`
      const content = readFileSync(join(ROOT, "..", file), "utf-8").replace(
        /\n+$/,
        "\n"
      )
      expect(corpus).toContain(content)
    }
  })

  it("embeds the canonical agent.md and speech.md machine contracts in full", () => {
    for (const contract of ["app/public/agent.md", "app/public/speech.md"]) {
      const content = readFileSync(join(ROOT, "..", contract), "utf-8")
      expect(corpus).toContain(
        `Canonical URL: ${SITE_ORIGIN}/${contract.replace("app/public/", "")}`
      )
      expect(corpus).toContain(`Source: ${contract}`)
      expect(corpus).toContain(content.replace(/\n+$/, "\n"))
    }
  })
})

describe("no runtime filesystem dependency for deployed docs", () => {
  it("keeps Node builtins out of the pure navigation module and the client layout", () => {
    for (const file of [
      "src/common/docsNav.ts",
      "src/components/DocsLayout.tsx",
    ]) {
      const source = readFileSync(join(ROOT, file), "utf-8")
      expect(source).not.toMatch(/from "(node:)?(fs|path|url)"/)
    }
  })

  it("reads Markdown only inside the server loader used by getStaticProps/getStaticPaths", () => {
    const page = readFileSync(
      join(ROOT, "src/pages/docs/[[...slug]].tsx"),
      "utf-8"
    )
    expect(page).toContain("buildDocsStaticPaths")
    expect(page).toContain("buildDocsStaticProps")
    const loader = readFileSync(
      join(ROOT, "src/common/docsContent.server.ts"),
      "utf-8"
    )
    expect(loader).toMatch(/from "node:(fs|path)"/)
    for (const file of [
      "src/common/docsNav.ts",
      "src/components/DocsLayout.tsx",
    ]) {
      expect(readFileSync(join(ROOT, file), "utf-8")).not.toContain(
        "docsContent.server"
      )
    }
  })
})
