import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// Production intentionally bypasses Turnstile for fresh-Human sessions.
// Keep the browser and Worker switches paired so deployment cannot silently
// reintroduce a visible challenge or a server-side Siteverify call.
//
// Deliberately not a YAML parse: exact string assertions cover the small
// deployment contract without adding a dependency or a framework.
const ROOT = process.cwd()

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8")
}

// Comments may name switches to explain the deployment contract; only real
// workflow lines can actually set one.
function effectiveLines(file: string): string {
  return file
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
}

describe("production deploy disables Turnstile admission", () => {
  const deployWorkflow = effectiveLines(
    read("../.github/workflows/deploy-web.yml")
  )

  it("disables the browser challenge in the production build", () => {
    expect(deployWorkflow).toContain(
      'NEXT_PUBLIC_TURNSTILE_DISABLED: "1"'
    )
  })

  it("disables Worker Siteverify for fresh sessions", () => {
    const varLines = deployWorkflow
      .split("\n")
      .filter((line) => line.includes("--var"))
    expect(varLines.length).toBeGreaterThan(0)
    expect(varLines).toContain('            --var "TURNSTILE_DISABLED:true" \\')
  })

  it("does not require a Turnstile site key to deploy", () => {
    expect(deployWorkflow).not.toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
    expect(deployWorkflow).toContain('run: test -n "$SFU_APP_ID"')
  })

  it("does not depend on the Turnstile server secret", () => {
    expect(deployWorkflow).not.toContain("secrets.TURNSTILE_SECRET_KEY")
  })
})

describe("local E2E keeps an explicit Turnstile bypass", () => {
  it("declares the Worker-side bypass instead of relying on fail-open", () => {
    const harness = read("e2e/room/run-local-worker.mjs")
    expect(harness).toContain('TURNSTILE_DISABLED: "true"')
  })
})

// #406: expensive admission is throttled by binding, not by a KV counter, so
// removing a binding would silently drop the throttle (the code falls back to
// KV, which is also what the fallback tests cover). Keep the production
// configuration honest.
describe("admission throttling stays wired to Workers Rate Limiting", () => {
  const wrangler = read("wrangler.jsonc")

  it("declares every binding the Worker reads", () => {
    for (const name of [
      "SFU_ADMISSION_RATE_LIMITER",
      "MCP_JOIN_RATE_LIMITER",
      "ROOM_PROBE_RATE_LIMITER",
      "MCP_HANDLE_RATE_LIMITER",
      "MCP_WAIT_RATE_LIMITER",
    ])
      expect(wrangler).toContain(`"name": "${name}"`)
    expect(wrangler.match(/"namespace_id"/g)).toHaveLength(5)
  })

  it("keeps a bounded per-location budget on each binding", () => {
    expect(
      wrangler.match(/"simple": \{ "limit": \d+, "period": (10|60) \}/g)
    ).toHaveLength(5)
  })
})
