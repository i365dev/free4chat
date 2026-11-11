import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const ROOT = process.cwd()

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8")
}

describe("Privacy copy accuracy", () => {
  const source = read("src/pages/privacy.tsx")

  it("distinguishes browser-to-browser file transfers from the Agent-readable copy", () => {
    expect(source).toMatch(/不建立人与人之间传输的文件或图片数据库/)
    expect(source).toMatch(/Agent/)
    expect(source).toMatch(/受限临时副本/)
  })

  it("distinguishes bounded Agent-readable images from explicit text-like Room artifacts", () => {
    expect(source.toLowerCase()).toMatch(/agent/)
    expect(source).toMatch(/Durable Object/)
    expect(source).toMatch(/受限/)
    expect(source).toMatch(/Markdown/)
    expect(source).toMatch(/JSON/)
    expect(source).not.toMatch(/never any other file type/i)
  })

  it("discloses that BOTH room name and nickname are saved in localStorage until manually cleared", () => {
    expect(source).toMatch(/房间名称/)
    expect(source).toMatch(/昵称/)
    expect(source).toMatch(/localStorage/)
    expect(source).toMatch(/清除/)
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
    expect(homepage).toMatch(/不保留永久历史记录/)
    expect(temporaryRoom).toMatch(/服务器不保留永久房间历史记录/)
  })
})

describe("/ai-agent-room copy accuracy", () => {
  const source = read("src/pages/ai-agent-room.tsx")

  it("does not claim every Agent necessarily joins through the local Agent Runtime", () => {
    expect(source).toMatch(/直接连接/)
    expect(source).toMatch(/MCP/)
    // The old wording asserted the Runtime step unconditionally; the fixed
    // copy must present it as one of (at least) two paths.
    expect(source).toMatch(/常驻 Agent/)
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
    expect(publicSources[3]).toMatch(/移动设备/)
    expect(publicSources[3]).toMatch(/不是云端任务运行器/)
    expect(publicSources[3]).toMatch(/Windows 不能作为 Agent Runtime 的运行主机/)
  })

  it("keeps Agent-enabled Room App claims limited to selected Apps and Whiteboard", () => {
    const useCases = read("src/pages/use-cases.tsx").replace(/\s+/g, " ")
    expect(useCases).toMatch(/部分精选房间应用/)
    expect(useCases).toMatch(/正式版白板/)
    expect(useCases).toMatch(/并不代表所有房间应用都具备此能力/)
    expect(useCases).not.toMatch(
      /\bHome Assistant\b|\bBLE\b|\bserial[- ]device\b/i
    )
  })
})
