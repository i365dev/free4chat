#!/usr/bin/env node
/**
 * Deterministic generator for the public docs discovery assets:
 *
 *   - app/public/llms.txt        compact LLM-facing index
 *   - app/public/llms-full.txt   full Agent-readable corpus (docs + contracts)
 *   - app/public/sitemap.xml     all public URLs, including every docs route
 *
 * The only inputs are docs/en/navigation.json, the docs/en Markdown tree,
 * and the canonical machine contracts app/public/agent.md / speech.md.
 * Run `yarn docs:generate` after content changes; `yarn docs:check` (CI)
 * fails when the committed assets have drifted from those inputs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, "..")
const repoRoot = resolve(appRoot, "..")

const SITE_ORIGIN = "https://www.free4.chat"
const GITHUB_REPO = "https://github.com/i365dev/free4chat"

const DOCS_EN_DIR = join(repoRoot, "docs", "en")
const PUBLIC_DIR = join(appRoot, "public")

/** Sitemap URLs that exist independently of the docs library, in order. */
const BASE_SITEMAP_PATHS = [
  "/",
  "/temporary-chat-room",
  "/ai-agent-room",
  "/multi-agent-collaboration",
  "/privacy",
]

const CONTRACTS = [
  {
    path: "agent.md",
    url: `${SITE_ORIGIN}/agent.md`,
    source: "app/public/agent.md",
  },
  {
    path: "speech.md",
    url: `${SITE_ORIGIN}/speech.md`,
    source: "app/public/speech.md",
  },
]

function readNavigation() {
  const file = join(DOCS_EN_DIR, "navigation.json")
  const nav = JSON.parse(readFileSync(file, "utf-8"))
  if (!nav || !nav.home || !Array.isArray(nav.sections)) {
    throw new Error(`malformed navigation.json: ${file}`)
  }
  return nav
}

/** All docs pages in canonical order: home first, then sections in order. */
function flattenPages(nav) {
  return [nav.home, ...nav.sections.flatMap((section) => section.pages)]
}

function docsUrl(slug) {
  return slug === "" ? `${SITE_ORIGIN}/docs` : `${SITE_ORIGIN}/docs/${slug}`
}

function docsSourceFile(slug) {
  return slug === "" ? "docs/en/index.md" : `docs/en/${slug}.md`
}

function readMarkdown(slug) {
  const file = join(DOCS_EN_DIR, slug === "" ? "index.md" : `${slug}.md`)
  if (!existsSync(file)) {
    throw new Error(`navigation.json references missing Markdown file: ${file}`)
  }
  return normalizeTrailingNewline(readFileSync(file, "utf-8"))
}

function normalizeTrailingNewline(text) {
  return `${text.replace(/\n+$/, "")}\n`
}

function generateSitemap(nav) {
  const paths = [
    ...BASE_SITEMAP_PATHS,
    ...flattenPages(nav).map((p) =>
      p.slug === "" ? "/docs" : `/docs/${p.slug}`
    ),
  ]
  const entries = paths
    .map((path) => `  <url>\n    <loc>${SITE_ORIGIN}${path}</loc>\n  </url>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`
}

function generateLlmsTxt(nav) {
  const lines = [
    "# Free4Chat",
    "",
    `> Free4Chat is a temporary collaboration fabric for Humans and independently running Agents.`,
    "",
    "Free4Chat provides the temporary collaboration space. Participants bring the capabilities: temporary Rooms where Humans and independently running Agents collaborate as peers, with shared ephemeral context, structured request/result, bounded artifacts, and media transport. No accounts, no permanent workspace.",
    "",
    "## Documentation",
    "",
  ]
  for (const page of flattenPages(nav)) {
    lines.push(`- [${page.title}](${docsUrl(page.slug)}): ${page.description}`)
  }
  lines.push(
    "",
    "## Full corpus",
    "",
    `- [llms-full.txt](${SITE_ORIGIN}/llms-full.txt): the complete English documentation plus the canonical machine contracts in one deterministic file.`,
    "",
    "## Machine contracts",
    "",
    `- [Agent contract (agent.md)](${SITE_ORIGIN}/agent.md): canonical machine-readable Agent bootstrap and Room/MCP contract.`,
    `- [Speech contract (speech.md)](${SITE_ORIGIN}/speech.md): canonical machine-readable speech capability contract.`,
    "",
    "## Repository",
    "",
    `- [GitHub](${GITHUB_REPO}): Free4Chat source repository.`,
    ""
  )
  return lines.join("\n")
}

function generateLlmsFullTxt(nav) {
  const header = [
    "# Free4Chat documentation corpus",
    "",
    `> Free4Chat is a temporary collaboration fabric for Humans and independently running Agents.`,
    "",
    "Deterministic corpus of the English documentation and the canonical machine contracts. Each section identifies its canonical public URL and repository source. Content is ephemeral-Room documentation only; Free4Chat provides the temporary collaboration space, participants bring the capabilities.",
    "",
    "Sections:",
    "",
    ...flattenPages(nav).map(
      (page) => `- [${page.title}](${docsUrl(page.slug)})`
    ),
    ...CONTRACTS.map((contract) => `- [${contract.source}](${contract.url})`),
  ]
  const body = flattenPages(nav).map((page) =>
    sectionBlock({
      title: page.title,
      url: docsUrl(page.slug),
      source: docsSourceFile(page.slug),
      content: readMarkdown(page.slug),
    })
  )
  const contracts = CONTRACTS.map((contract) =>
    sectionBlock({
      title: contract.source,
      url: contract.url,
      source: contract.source,
      content: normalizeTrailingNewline(
        readFileSync(join(repoRoot, contract.source), "utf-8")
      ),
    })
  )
  return `${header.join("\n")}\n\n${[...body, ...contracts].join("\n")}`
}

function sectionBlock({ title, url, source, content }) {
  return [
    "---",
    "",
    `## ${title}`,
    "",
    `Canonical URL: ${url}`,
    `Source: ${source}`,
    "",
    content,
  ].join("\n")
}

function main() {
  const check = process.argv.includes("--check")
  const nav = readNavigation()
  const generated = new Map([
    ["public/llms.txt", generateLlmsTxt(nav)],
    ["public/llms-full.txt", generateLlmsFullTxt(nav)],
    ["public/sitemap.xml", generateSitemap(nav)],
  ])

  let failed = false
  for (const [rel, content] of generated) {
    const file = join(appRoot, rel)
    if (check) {
      if (!existsSync(file) || readFileSync(file, "utf-8") !== content) {
        console.error(
          `docs assets drift: ${rel} is stale; run \`yarn docs:generate\``
        )
        failed = true
      } else {
        console.log(`docs assets OK: ${rel}`)
      }
    } else {
      writeFileSync(file, content)
      console.log(`docs assets generated: ${rel}`)
    }
  }
  if (failed) {
    process.exit(1)
  }
}

main()
