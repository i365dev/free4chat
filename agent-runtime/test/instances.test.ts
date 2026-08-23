import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { InstanceRegistry } from "../src/core/instanceRegistry.js"
import { getLauncher } from "../src/adapters/launchers.js"
import { removeStaleWorkspaces } from "../src/daemon.js"

test("instance registry allows multiple resident Agents in one room", () => {
  const registry = new InstanceRegistry<{
    instanceId: string
    roomId: string
    name: string
  }>()
  registry.set({ instanceId: "hermes-1", roomId: "shared", name: "Hermes" })
  registry.set({ instanceId: "opencode-1", roomId: "shared", name: "OpenCode" })
  assert.deepEqual(
    registry.values().map((item) => item.name),
    ["Hermes", "OpenCode"]
  )
  assert.equal(registry.delete("hermes-1"), true)
  assert.equal(registry.get("opencode-1")?.roomId, "shared")
})

test("OpenCode launcher is forced to a loopback ephemeral ACP server", () => {
  assert.deepEqual(getLauncher("opencode").args, [
    "acp",
    "--hostname",
    "127.0.0.1",
    "--port",
    "0",
    "--mdns=false",
    "--pure",
  ])
})

test("Hermes launcher is explicitly marked trusted-room", () => {
  const launcher = getLauncher("hermes")
  assert.equal(launcher.security, "trusted-room")
  assert.match(launcher.notes ?? "", /no safe no-tools profile/i)
})

test("daemon startup removes stale per-instance workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "free4chat-workspaces-"))
  try {
    await mkdir(join(root, "stale-instance", ".meeting-notes"), {
      recursive: true,
    })
    await writeFile(
      join(root, "stale-instance", ".meeting-notes", "transcript.jsonl"),
      '{"speaker":"Alice","text":"private"}\n'
    )
    await removeStaleWorkspaces(root)
    await assert.rejects(stat(join(root, "stale-instance")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
