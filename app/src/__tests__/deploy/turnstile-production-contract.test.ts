import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// #406 PR 1: a production fresh-Human session must stay Turnstile-protected.
// These are contract assertions over the checked-in deploy workflow and the
// deterministic local E2E seam, so re-introducing a *default* production
// bypass fails here instead of silently reaching the deployed Worker.
//
// Deliberately not a YAML parse: the invariant is "no production step sets a
// Turnstile disable switch or materializes the server secret", which a few
// exact string assertions express without adding a dependency or a framework.
const ROOT = process.cwd()

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8")
}

// Comments may (and should) name the disable switches to explain why they are
// absent; only real workflow lines can actually set one.
function effectiveLines(file: string): string {
  return file
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
}

describe("production deploy keeps Turnstile admission enabled", () => {
  const deployWorkflow = effectiveLines(
    read("../.github/workflows/deploy-web.yml")
  )

  it("never sets the client-side Turnstile kill switch in a production build", () => {
    expect(deployWorkflow).not.toContain("NEXT_PUBLIC_TURNSTILE_DISABLED")
  })

  it("never passes the server-side Turnstile bypass to wrangler deploy", () => {
    const varLines = deployWorkflow
      .split("\n")
      .filter((line) => line.includes("--var"))
    expect(varLines.length).toBeGreaterThan(0)
    for (const line of varLines) {
      expect(line).not.toContain("TURNSTILE_DISABLED")
      expect(line).not.toContain("TURNSTILE_SECRET_KEY")
    }
  })

  it("keeps the public site key wired into the build and validated", () => {
    expect(deployWorkflow).toContain(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY: ${{ secrets.NEXT_PUBLIC_TURNSTILE_SITE_KEY }}"
    )
    expect(deployWorkflow).toContain(
      'test -n "$SFU_APP_ID" && test -n "$NEXT_PUBLIC_TURNSTILE_SITE_KEY"'
    )
  })

  it("never materializes the Turnstile server secret as a workflow value", () => {
    // The server secret is a Cloudflare Worker secret (see DEVELOPMENT.md),
    // never a GitHub secret passed as an env value or a plain deploy --var.
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
