import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

// Deterministic documentation/bootstrap consistency guard: public install
// instructions must track the npm registry (@latest), never a pinned source
// version, and release docs must match the actual tag-triggered workflow.
// Pure filesystem reads; no network, no npm queries.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8")
}

const PACKAGE = "@i365dev/free4chat-agent"
const PINNED_VERSION = new RegExp(
  `${PACKAGE.replace("/", "\\/")}@\\d+\\.\\d+\\.\\d+`
)

test("root README exposes exactly one registry-driven npm version badge", () => {
  const readme = read("README.md")
  const badgeMatches = readme.match(
    /\[!\[npm version\]\(https:\/\/img\.shields\.io\/npm\/v\/@i365dev\/free4chat-agent\.svg\)\]\(([^)]+)\)/g
  )
  assert.ok(badgeMatches && badgeMatches.length === 1)
  assert.ok(
    readme.includes(
      "](https://www.npmjs.com/package/@i365dev/free4chat-agent)"
    ),
    "badge must link to the real package page"
  )
})

test("agent.md bootstraps through @latest for both join and doctor fallbacks", () => {
  const agentMd = read("app/public/agent.md")
  assert.ok(
    agentMd.includes(`npx -y ${PACKAGE}@latest join`),
    "bootstrap command must use the registry dist-tag"
  )
  assert.ok(
    agentMd.includes(`npx -y ${PACKAGE}@latest doctor`),
    "diagnostic fallback must use the same selector"
  )
})

test("no public bootstrap doc pins a published-or-unpublished exact version", () => {
  for (const doc of [
    "app/public/agent.md",
    "DEVELOPMENT.md",
    "agent-runtime/README.md",
  ]) {
    const content = read(doc)
    const pinned = content.match(new RegExp(PINNED_VERSION, "g"))
    assert.equal(
      pinned,
      null,
      `${doc} must use @latest instead of a hardcoded version (found: ${pinned?.join(", ")})`
    )
  }
})

test("the source package.json version never appears as a bootstrap pin in agent.md", () => {
  const packageJson = JSON.parse(read("agent-runtime/package.json")) as {
    version: string
  }
  const agentMd = read("app/public/agent.md")
  assert.ok(
    !agentMd.includes(`${PACKAGE}@${packageJson.version}`),
    "public bootstrap must not point at the unpublished source version"
  )
})

test("DEVELOPMENT.md matches the actual tag-triggered publishing model", () => {
  const development = read("DEVELOPMENT.md")
  assert.ok(
    !development.includes("not published by CI"),
    "CI does publish: matching agent-runtime-v<package-version> tags trigger npm Trusted Publishing"
  )
  assert.ok(
    !development.includes("one-time maintainer action"),
    "publication is the routine tag-triggered workflow, not a one-time action"
  )
  assert.match(development, /agent-runtime-v<package-version>/)
  assert.match(development, /npm Trusted Publishing/)
})

test("release workflow stays fail-closed: tag-triggered only, mismatch rejected, no NPM token", () => {
  const workflow = read(".github/workflows/agent-runtime.yml")
  assert.match(
    workflow,
    /if:\s*startsWith\(github\.ref,\s*'refs\/tags\/agent-runtime-v'\)/
  )
  assert.match(workflow, /does not match package\.json version/)
  assert.match(workflow, /id-token:\s*write/)
  assert.ok(!workflow.includes("NPM_TOKEN"))
})
