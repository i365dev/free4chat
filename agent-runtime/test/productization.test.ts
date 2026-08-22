import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  BUILT_IN_AGENT_IDS,
  RUNTIME_PACKAGE_NAME,
  RUNTIME_PACKAGE_VERSION,
  buildBootstrapInvocation,
} from "../src/bootstrap.js"
import { collectDoctorReport, formatDoctorReport } from "../src/doctor.js"

test("publishable package metadata keeps the CLI identity stable", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as Record<string, unknown>
  assert.equal(packageJson.name, RUNTIME_PACKAGE_NAME)
  assert.equal(packageJson.version, RUNTIME_PACKAGE_VERSION)
  assert.equal(packageJson.private, undefined)
  assert.deepEqual(packageJson.bin, { "free4chat-agent": "dist/cli.js" })
  assert.equal(packageJson.license, "MIT")
  assert.deepEqual(packageJson.publishConfig, { access: "public" })
  assert.equal((packageJson.engines as Record<string, string>).node, ">=22")
  assert.equal(
    (packageJson.scripts as Record<string, string>)?.postinstall,
    undefined
  )
})

test("bootstrap command uses the official pinned package and argv boundaries", () => {
  const invocation = buildBootstrapInvocation(
    "room\nwith `quotes`",
    "opencode",
    "Agent Name"
  )
  assert.equal(invocation.command, "npx")
  assert.deepEqual(invocation.args, [
    "-y",
    "@i365dev/free4chat-agent@0.1.0",
    "join",
    "--room",
    "room\nwith `quotes`",
    "--agent",
    "opencode",
    "--name",
    "Agent Name",
  ])
  assert.deepEqual(BUILT_IN_AGENT_IDS, [
    "hermes",
    "opencode",
    "codex",
    "claude",
    "pi",
    "deepseek-harness",
  ])
})

test("doctor reports readiness without exposing environment or secret paths", () => {
  const report = collectDoctorReport({
    PATH: process.env.PATH,
    FREE4CHAT_DEEPSEEK_REPO: "/private/operator/secret-checkout",
    ANTHROPIC_API_KEY: "must-not-appear",
  })
  const output = `${JSON.stringify(report)}\n${formatDoctorReport(report)}`
  assert.match(output, /free4chat-agent|launchers|trusted-room/)
  assert.doesNotMatch(
    output,
    /must-not-appear|secret-checkout|ANTHROPIC_API_KEY/
  )
  assert.doesNotMatch(output, /participantHandle|cursor|expiresAt|token/i)
})
