import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const ROOT = process.cwd()

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8")
}

describe("Privacy copy accuracy", () => {
  const source = read("src/pages/privacy.tsx")

  it("does not make an unqualified 'no database of files or images' claim — the Agent-image exception must be acknowledged in the same breath", () => {
    // The old, inaccurate wording had no "exception"/"Agent" language
    // anywhere near the "never written to server storage" claim.
    const noDatabaseClaim = source.match(/No database of[^.]*\./)?.[0]
    expect(
      noDatabaseClaim,
      "expected a 'No database of...' sentence"
    ).toBeTruthy()
    expect(noDatabaseClaim!.toLowerCase()).toMatch(/human-to-human/)
  })

  it("distinguishes bounded Agent-readable images from explicit text-like Room artifacts", () => {
    expect(source.toLowerCase()).toMatch(/agent/)
    expect(source).toMatch(/Durable Object/)
    expect(source.toLowerCase()).toMatch(/bounded/)
    expect(source).toMatch(/Markdown/)
    expect(source).toMatch(/JSON/)
    expect(source).not.toMatch(/never any other file type/i)
  })

  it("discloses that BOTH room name and nickname are saved in localStorage, until manually cleared", () => {
    expect(source).toMatch(/room name/i)
    expect(source).toMatch(/nickname/i)
    expect(source).toMatch(/localStorage/)
    expect(source).toMatch(/clear/i)
  })
})

describe("Homepage and /temporary-chat-room copy accuracy", () => {
  const homepage = read("src/pages/index.tsx")
  const temporaryRoom = read("src/pages/temporary-chat-room.tsx")

  it("does not claim nothing persists once the tab closes", () => {
    for (const source of [homepage, temporaryRoom]) {
      expect(source).not.toMatch(/close the tab and it.s gone/i)
      expect(source).not.toMatch(/nothing left behind/i)
    }
  })

  it("scopes 'no history' claims to Free4Chat's servers, not an absolute guarantee", () => {
    expect(homepage).toMatch(/no permanent room history/i)
    expect(temporaryRoom).toMatch(
      /no permanent (room )?history on our servers/i
    )
  })
})

describe("/ai-agent-room copy accuracy", () => {
  const source = read("src/pages/ai-agent-room.tsx")

  it("does not claim every Agent necessarily joins through the local Agent Runtime", () => {
    expect(source).toMatch(/direct/i)
    expect(source).toMatch(/MCP/)
    // The old wording asserted the Runtime step unconditionally; the fixed
    // copy must present it as one of (at least) two paths.
    expect(source).toMatch(/resident/i)
  })
})

describe("Runtime host and Human supervision platform copy", () => {
  const publicSources = [
    read("src/pages/index.tsx"),
    read("src/pages/ai-agent-room.tsx"),
    read("src/pages/agent-tasks.tsx"),
    read("src/pages/remote-agent.tsx"),
  ].map((source) => source.replace(/\s+/g, " "))

  it("states macOS/Linux Runtime hosts and allows Windows/mobile Human browsers", () => {
    for (const source of publicSources) {
      expect(source).toMatch(/macOS/)
      expect(source).toMatch(/Linux/)
      expect(source).toMatch(/Windows/)
    }
    expect(publicSources[3]).toMatch(/mobile/)
    expect(publicSources[3]).toMatch(/not a cloud job runner/)
    expect(publicSources[3]).toMatch(
      /Windows does not currently host the Agent Runtime/
    )
  })

  it("keeps Agent-enabled Room App claims limited to selected Apps and Whiteboard", () => {
    const useCases = read("src/pages/use-cases.tsx").replace(/\s+/g, " ")
    expect(useCases).toMatch(/Selected curated Room Apps/)
    expect(useCases).toMatch(/production Whiteboard/)
    expect(useCases).toMatch(/not a promise about every Room App/)
    expect(useCases).not.toMatch(
      /\bHome Assistant\b|\bBLE\b|\bserial[- ]device\b/i
    )
  })
})
