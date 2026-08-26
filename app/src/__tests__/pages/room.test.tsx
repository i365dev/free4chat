import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// Rendering next/head's real DOM side effect requires the full Next.js app
// shell (it depends on internals that bypass Vitest's module mocking when
// resolved as a Next-internal import), so this asserts against the page's
// authored source instead of a rendered document — a robust, dependency-free
// way to pin the noindex contract for this ephemeral, per-room URL.
describe("Room page", () => {
  it("is noindex, nofollow so ephemeral room URLs are never crawled or indexed", () => {
    const source = readFileSync(
      join(process.cwd(), "src/pages/room.tsx"),
      "utf-8"
    )
    expect(source).toMatch(
      /<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/>/
    )
  })
})
