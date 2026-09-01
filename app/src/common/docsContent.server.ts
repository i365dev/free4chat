/**
 * Build-time loader for the public docs library. Reads ../docs/en from the
 * repository during `next build` (getStaticPaths/getStaticProps) so that
 * production Cloudflare requests never touch the repository filesystem:
 * every route is prerendered with fallback: false.
 *
 * Import this module ONLY from getStaticPaths/getStaticProps (and tests).
 * Next.js eliminates getStaticProps code from the client bundle, which is
 * what keeps the Node builtins here out of browser code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  docsPathFromSlug,
  docsSlugToPathParts,
  flattenDocsPages,
  type DocsNavEntry,
  type DocsNavigation,
  type DocsPageLink,
  type DocsPageProps,
} from "./docsNav"

const GITHUB_SOURCE_BASE =
  "https://github.com/i365dev/free4chat/blob/cf-sfu/docs/en"

export interface DocsStaticPathsResult {
  paths: Array<{ params: { slug?: string[] } }>
  fallback: false
}

export type DocsStaticPropsResult =
  | { props: DocsPageProps }
  | { notFound: true }

/**
 * The docs content lives in the repository root's docs/en directory. Next
 * build and vitest both run with app/ as the working directory; support the
 * repository root as well so tests and tooling stay robust.
 */
function findDocsEnRoot(): string {
  const candidates = [
    resolve(process.cwd(), "..", "docs", "en"),
    resolve(process.cwd(), "docs", "en"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate
    }
  }
  throw new Error(
    `docs/en directory not found (tried: ${candidates.join(", ")})`
  )
}

export function loadDocsNavigation(): DocsNavigation {
  const file = join(findDocsEnRoot(), "navigation.json")
  const nav = JSON.parse(readFileSync(file, "utf-8")) as DocsNavigation
  if (
    !nav ||
    typeof nav !== "object" ||
    !nav.home ||
    !Array.isArray(nav.sections)
  ) {
    throw new Error(`docs navigation.json is malformed: ${file}`)
  }
  return nav
}

/** Slugs of every Markdown page under docs/en, relative and .md-less. */
export function listDocsMarkdownSlugs(): string[] {
  const root = findDocsEnRoot()
  const slugs: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      } else if (entry.name.endsWith(".md")) {
        const name = entry.name.replace(/\.md$/, "")
        slugs.push(
          name === "index" ? prefix.replace(/\/$/, "") : `${prefix}${name}`
        )
      }
    }
  }
  walk(root, "")
  return slugs.sort()
}

/**
 * Resolve slug path parts to a file inside docs/en. Returns null for
 * anything missing or escaping the directory (defense in depth against path
 * traversal, even though paths are generated internally).
 */
function resolveDocsFile(slugParts: string[]): string | null {
  const cleaned = slugParts.filter((part) => part !== "")
  for (const part of cleaned) {
    if (
      part === "." ||
      part === ".." ||
      part.includes("/") ||
      part.includes("\\")
    ) {
      return null
    }
  }
  const root = resolve(findDocsEnRoot())
  const rel = cleaned.length === 0 ? "index.md" : `${cleaned.join("/")}.md`
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(`${root}${sep()}`)) {
    return null
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return null
  }
  return abs
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/"
}

function entryToLink(entry: DocsNavEntry): DocsPageLink {
  return { title: entry.title, href: docsPathFromSlug(entry.slug) }
}

function buildProps(
  nav: DocsNavigation,
  slugParts: string[]
): DocsStaticPropsResult {
  const file = resolveDocsFile(slugParts)
  if (!file) {
    return { notFound: true }
  }
  const slug = slugParts.join("/")
  const pages = flattenDocsPages(nav)
  const index = pages.findIndex((page) => page.slug === slug)
  // Navigation is the single source of routes: a readable file that is not
  // in navigation.json must not become a page.
  if (index < 0) {
    return { notFound: true }
  }
  const entry = pages[index]
  const prev = index > 0 ? entryToLink(pages[index - 1]) : null
  const next = index < pages.length - 1 ? entryToLink(pages[index + 1]) : null
  const sourceName = slug === "" ? "index.md" : `${slug}.md`
  return {
    props: {
      source: readFileSync(file, "utf-8"),
      slugParts,
      title: entry.title,
      description: entry.description,
      canonicalPath: docsPathFromSlug(slug),
      githubEditUrl: `${GITHUB_SOURCE_BASE}/${sourceName}`,
      prev,
      next,
      sidebar: nav,
    },
  }
}

/** Enumerate every docs route at build time. */
export function buildDocsStaticPaths(): DocsStaticPathsResult {
  const nav = loadDocsNavigation()
  const paths = flattenDocsPages(nav).map((page) => ({
    params:
      page.slug === ""
        ? { slug: [] as string[] }
        : { slug: docsSlugToPathParts(page.slug) },
  }))
  return { paths, fallback: false }
}

export function buildDocsStaticProps(
  slug: string[] | string | undefined
): DocsStaticPropsResult {
  const rawParts = Array.isArray(slug) ? slug : slug === undefined ? [] : [slug]
  if (rawParts.some((part) => typeof part !== "string")) {
    return { notFound: true }
  }
  return buildProps(loadDocsNavigation(), rawParts)
}
