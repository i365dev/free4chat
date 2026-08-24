import assert from "node:assert/strict"
import { test } from "node:test"

import { buildReadinessReport, mediaReadiness } from "../src/readiness.js"

test("mediaReadiness: pion engine reports not_provisioned on a fresh machine", async () => {
  const report = await mediaReadiness({
    FREE4CHAT_AGENT_DIR: "/tmp/free4chat-pion-test/readiness-empty",
  })
  assert.equal(report.engine, "pion")
  assert.equal(report.supported, true)
  assert.equal(report.ready, false)
  assert.equal(report.reason, "not_provisioned")
})

test("mediaReadiness: override bin that exists is ready", async () => {
  const report = await mediaReadiness({
    FREE4CHAT_PION_BIN: process.execPath, // any existing file path
    FREE4CHAT_AGENT_DIR: "/tmp/free4chat-pion-test/readiness-override",
  })
  assert.equal(report.engine, "pion")
  assert.equal(report.ready, true)
  assert.ok(report.binPath)
})

test("mediaReadiness: werift fallback is always ready without provisioning", async () => {
  const report = await mediaReadiness({
    FREE4CHAT_MEDIA_ENGINE: "werift",
    FREE4CHAT_AGENT_DIR: "/tmp/free4chat-pion-test/readiness-werift",
  })
  assert.equal(report.engine, "werift")
  assert.equal(report.ready, true)
})

test("buildReadinessReport: full JSON shape with unconfigured speech", async () => {
  const report = await buildReadinessReport(
    {
      FREE4CHAT_AGENT_DIR: "/tmp/free4chat-pion-test/readiness-report",
    },
    {
      registry: {
        get: () => undefined,
      },
    } as never
  )
  assert.equal(report.runtime.ready, true)
  assert.equal(report.media.engine, "pion")
  assert.equal(report.media.ready, false)
  assert.equal(report.speech.stt.configured, false)
  assert.equal(report.speech.stt.needsUserInput, "api_key")
})
