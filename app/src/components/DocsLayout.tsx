import { useState } from "react"
import type { ReactNode } from "react"

import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import DiscoveryFooter from "./DiscoveryFooter"
import SeoHead from "./SeoHead"
import {
  DOCS_ROOT_PATH,
  docsPathFromSlug,
  resolveDocHref,
  type DocsNavSection,
  type DocsNavigation,
  type DocsPageProps,
} from "../common/docsNav"

const GITHUB_REPO = "https://github.com/i365dev/free4chat"

function SidebarNav({
  sidebar,
  activeHref,
}: {
  sidebar: DocsNavigation
  activeHref: string
}) {
  return (
    <nav aria-label="Documentation" className="space-y-6 text-sm">
      <Link
        href={DOCS_ROOT_PATH}
        className={
          activeHref === DOCS_ROOT_PATH
            ? "block font-medium text-white"
            : "block text-gray-400 hover:text-gray-200"
        }
      >
        {sidebar.home.title}
      </Link>
      {sidebar.sections.map((section: DocsNavSection) => (
        <div key={section.id}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {section.title}
          </p>
          <ul className="space-y-1">
            {section.pages.map((page) => {
              const href = docsPathFromSlug(page.slug)
              return (
                <li key={page.slug}>
                  <Link
                    href={href}
                    aria-current={activeHref === href ? "page" : undefined}
                    className={
                      activeHref === href
                        ? "block font-medium text-white"
                        : "block text-gray-400 hover:text-gray-200"
                    }
                  >
                    {page.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Reference
        </p>
        <ul className="space-y-1">
          {sidebar.external.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                {...(link.href.startsWith("http")
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className="block text-gray-400 hover:text-gray-200"
              >
                {link.title}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}

/**
 * Docs article link policy: relative Markdown links resolve to /docs URLs
 * (client-side navigable), site-absolute links stay plain anchors, and
 * cross-origin links open safely in a new tab. Raw HTML in the Markdown is
 * never executed: react-markdown skips HTML nodes unless rehype-raw is
 * added, and it is not.
 */
function useDocsMarkdownComponents(slugParts: string[]) {
  return {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (!href) {
        return <a>{children}</a>
      }
      const resolved = resolveDocHref(href, slugParts)
      if (
        resolved === DOCS_ROOT_PATH ||
        resolved.startsWith(`${DOCS_ROOT_PATH}/`)
      ) {
        return <Link href={resolved}>{children}</Link>
      }
      if (/^https?:\/\//.test(resolved)) {
        return (
          <a href={resolved} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      }
      return <a href={resolved}>{children}</a>
    },
    // No images are shipped in the docs; never load remote content.
    img: () => null,
  }
}

export default function DocsLayout(props: DocsPageProps) {
  const {
    source,
    slugParts,
    title,
    description,
    canonicalPath,
    githubEditUrl,
    prev,
    next,
    sidebar,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const components = useDocsMarkdownComponents(slugParts)
  const nav = <SidebarNav sidebar={sidebar} activeHref={canonicalPath} />
  return (
    <div className="flex min-h-screen flex-col bg-gray-900 text-white">
      <SeoHead
        title={`${title} — Free4Chat Docs`}
        description={description}
        path={canonicalPath}
      />
      <header className="border-b border-gray-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/"
              className="font-semibold text-white hover:text-gray-300"
            >
              Free4Chat
            </Link>
            <span className="text-gray-600">/</span>
            <Link
              href={DOCS_ROOT_PATH}
              className="text-gray-400 hover:text-gray-200"
            >
              Docs
            </Link>
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-400 md:hidden"
            aria-expanded={menuOpen}
          >
            Menu
          </button>
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden text-xs text-gray-500 hover:text-gray-300 md:block"
          >
            GitHub
          </a>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-10 px-4 py-8">
        <aside className="hidden w-56 flex-none md:block">
          <div className="sticky top-8">{nav}</div>
        </aside>
        <main className="min-w-0 flex-1">
          {menuOpen && (
            <div className="mb-8 border-b border-gray-800 pb-8 md:hidden">
              {nav}
            </div>
          )}
          <article className="prose prose-invert max-w-none text-gray-300 prose-headings:text-white prose-a:text-blue-400 prose-strong:text-white prose-code:text-gray-200">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {source}
            </ReactMarkdown>
          </article>
          <div className="mt-10 flex items-center justify-between gap-4 border-t border-gray-800 pt-6 text-sm">
            {prev ? (
              <Link
                href={prev.href}
                className="text-gray-400 hover:text-gray-200"
              >
                &larr; {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={next.href}
                className="text-right text-gray-400 hover:text-gray-200"
              >
                {next.title} &rarr;
              </Link>
            ) : (
              <span />
            )}
          </div>
          <div className="mt-6 text-xs text-gray-500">
            <a href={githubEditUrl} target="_blank" rel="noopener noreferrer">
              Edit this page on GitHub
            </a>
          </div>
        </main>
      </div>
      <DiscoveryFooter />
    </div>
  )
}
