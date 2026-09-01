/**
 * Pure, environment-free helpers for the public docs library. Shared by the
 * docs page, the layout, and deterministic tests. Never import Node builtins
 * here: this module is part of the client bundle.
 */

export interface DocsNavEntry {
  slug: string
  title: string
  description: string
}

export interface DocsNavSection {
  id: string
  title: string
  pages: DocsNavEntry[]
}

export interface DocsNavExternalLink {
  title: string
  href: string
  description: string
}

export interface DocsNavigation {
  locale: string
  home: DocsNavEntry
  sections: DocsNavSection[]
  external: DocsNavExternalLink[]
}

export const DOCS_ROOT_PATH = "/docs"

/** A previous/next navigation link rendered under an article. */
export interface DocsPageLink {
  title: string
  href: string
}

/** Build-time props of the docs page, produced by the server-side docs loader. */
export interface DocsPageProps {
  source: string
  slugParts: string[]
  title: string
  description: string
  canonicalPath: string
  githubEditUrl: string
  prev: DocsPageLink | null
  next: DocsPageLink | null
  sidebar: DocsNavigation
}

/** /docs for the index page, /docs/<slug> for everything else. */
export function docsPathFromSlug(slug: string): string {
  return slug === "" ? DOCS_ROOT_PATH : `${DOCS_ROOT_PATH}/${slug}`
}

/** URL path parts of a docs page slug, as consumed by the catch-all route. */
export function docsSlugToPathParts(slug: string): string[] {
  return slug.split("/").filter((part) => part !== "")
}

/** All docs pages in canonical order: home first, then sections in order. */
export function flattenDocsPages(nav: DocsNavigation): DocsNavEntry[] {
  return [nav.home, ...nav.sections.flatMap((section) => section.pages)]
}

const HREF_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * Resolve a link found in docs Markdown to the URL it should render as.
 *
 * - site-absolute (/agent.md) and scheme/fragment links pass through
 * - bare relative links resolve against the current page's directory, so
 *   (room) and (../guides/x) behave like filesystem-relative links
 */
export function resolveDocHref(href: string, slugParts: string[]): string {
  if (
    href.startsWith("#") ||
    href.startsWith("//") ||
    HREF_SCHEME_RE.test(href)
  ) {
    return href
  }
  if (href.startsWith("/")) {
    return href
  }
  const dir =
    slugParts.length > 0
      ? `/docs/${slugParts.slice(0, -1).join("/")}/`
      : "/docs/"
  const resolved = new URL(href, `https://docs.invalid${dir}`)
  return `${resolved.pathname}${resolved.search}${resolved.hash}`
}
