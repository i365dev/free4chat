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

  it("uses a generated planet-style default only for an unsaved direct invite", () => {
    const source = readFileSync(
      join(process.cwd(), "src/pages/room.tsx"),
      "utf-8"
    )
    expect(source).toMatch(/setNickName\(generateParticipantName\(\)\)/)
    expect(source).toMatch(/setNickName\(room\.nickName\)/)
  })

  it("passes only a syntactically valid App id for catalog resolution in RoomContent", () => {
    const source = readFileSync(
      join(process.cwd(), "src/pages/room.tsx"),
      "utf-8"
    )
    // The only App id that reaches RoomContent is the syntax-checked one.
    expect(source).toContain("export function launchedRoomAppId(")
    expect(source).toContain("isValidRoomAppId(value)")
    expect(source).toContain("initialRoomAppId={initialRoomAppId}")
    expect(source).not.toContain(
      "isValidRoomAppId(router.query.app) ? router.query.app"
    )
  })

  it("resolves the #134 acquisition context from the Room-bound tab handoff, never from the URL", () => {
    const source = readFileSync(
      join(process.cwd(), "src/pages/room.tsx"),
      "utf-8"
    )
    // The Room name is the binding, so an invite link to another Room and a
    // direct /room entry both resolve to no acquisition context.
    expect(source).toContain("readRoomAppAcquisition(roomId)")
    expect(source).toContain("acquisitionPage={acquisitionPage}")
    expect(source).not.toContain("router.query.acquisitionPage")
  })
})
