# Free4Chat documentation library

This directory is the source of truth for the public documentation at
`https://www.free4.chat/docs`. Content is plain Markdown; the Next.js app
(`app/`) is only the renderer/navigation/SEO infrastructure.

## Layout

```text
docs/
  README.md          this file
  en/                the shipped locale (English only for now)
    navigation.json  sidebar, titles, descriptions, ordering
    index.md         rendered at /docs
    getting-started/ concepts/  guides/  reference/
```

## Locale convention

Documentation is Markdown-first and translation-ready. The future locale
mapping is:

```text
docs/en/...  ->  https://www.free4.chat/docs/...
docs/zh/...  ->  https://www.free4.chat/zh/docs/...
```

Only `docs/en/` exists today. Do not create placeholder translated pages or
machine-translated content; add a locale only when real translated content
ships with it.

## Source-of-truth boundaries

Avoid drifting copies of the same protocol text:

- `/docs` - Human-friendly concepts, guides, and stable reference.
- `/agent.md` (`app/public/agent.md`) - canonical Agent-readable bootstrap
  and Room/MCP machine contract.
- `/speech.md` (`app/public/speech.md`) - canonical Agent-readable speech
  capability contract.
- `/developers/mcp` - existing developer-facing MCP protocol page.
- `README.md` (repository root) - repository orientation.

Docs pages link to the machine contracts instead of duplicating them.

## Build-time pipeline

- The docs renderer (`app/src/pages/docs/[[...slug]].tsx`) enumerates every
  route at build time from `navigation.json` and reads `docs/en/**/*.md`
  from this directory during `next build`. Production requests never read
  Markdown from the repository filesystem.
- `app/scripts/generate-docs-assets.mjs` deterministically generates
  `app/public/llms.txt`, `app/public/llms-full.txt` (English docs plus
  `agent.md`/`speech.md`), and `app/public/sitemap.xml`:

  ```sh
  cd app
  yarn docs:generate   # regenerate the generated assets
  yarn docs:check      # fail when the committed assets are stale
  ```

  CI runs `docs:check`, so drift between `navigation.json`, the Markdown
  files, the sitemap, and the `llms*.txt` files fails visibly.
