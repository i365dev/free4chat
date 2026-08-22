import assert from "node:assert/strict"
import { test } from "node:test"

import { InstanceRegistry } from "../src/core/instanceRegistry.js"

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
