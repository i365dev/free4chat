import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

/**
 * Routing regression guard (#105 review): an early unconditional `return`
 * in the command dispatcher once made `status` / `leave` / `stop` silently
 * unreachable. TypeScript and ESLint cannot catch that class of bug, so the
 * routing itself is pinned here via real subprocess exits.
 */

function runCli(args: string[], agentDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        FREE4CHAT_AGENT_DIR: agentDir,
        FREE4CHAT_MCP_URL: "https://www.free4.chat/mcp",
      },
    }
  )
}

test("cli routes status/leave/stop instead of falling through silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "free4chat-cli-routing-"))
  try {
    // With no daemon running these must still produce observable output
    // (connection error surfaced through formatCliError), never exit
    // silently because the dispatcher fell through past the command.
    for (const args of [["status"], ["leave", "some-instance"], ["stop"]]) {
      const result = runCli(args, dir)
      const output = `${result.stdout}${result.stderr}`
      assert.ok(
        output.trim().length > 0,
        `cli ${args.join(" ")} produced no output`
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("speech status does not trigger a reload-speech side effect", async () => {
  // Guarded at the source level: only `setup` may ask the daemon to reload.
  const src = await (
    await import("node:fs/promises")
  ).readFile(new URL("../src/cli.ts", import.meta.url), "utf8")
  const speechBlock = src.slice(
    src.indexOf('command === "speech"'),
    src.indexOf('command === "status"')
  )
  assert.ok(speechBlock.includes('"reload-speech"'))
  assert.match(speechBlock, /subcommand === "setup"/)
})
