import assert from "node:assert/strict"
import { test } from "node:test"

import { InstanceRegistry } from "../src/core/instanceRegistry.js"
import { getLauncher } from "../src/adapters/launchers.js"

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
