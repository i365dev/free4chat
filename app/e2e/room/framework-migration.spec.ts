import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { expect, test } from "@playwright/test"

test("Worker serves Pages Router docs, navigation and the legacy redirect", async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  for (const pathname of ["/", "/docs", "/docs/reference/mcp"]) {
    const response = await page.goto(pathname)
    expect(response?.status()).toBe(200)
    await expect(page.locator("body")).not.toContainText(
      "Internal Server Error"
    )
  }
  await expect(page.locator("body")).toContainText("room_info")
  // Exercise hydrated client navigation back into another prerendered page.
  await page.locator('a[href="/docs"]').first().click()
  await expect(page).toHaveURL(/\/docs$/)
  const redirect = await request.get("/developers/mcp", { maxRedirects: 0 })
  expect(redirect.status()).toBe(308)
  expect(redirect.headers().location).toMatch(/\/docs\/reference\/mcp$/)
  expect((await request.get("/docs/not-a-real-page")).status()).toBe(404)
  expect(errors).toEqual([])
})

test("canonical Go Runtime client completes the real Worker MCP lifecycle", async () => {
  test.setTimeout(180_000)
  const { stdout } = await promisify(execFile)(
    "go",
    [
      "test",
      "./internal/free4chat",
      "-run",
      "^TestWorkerMCPContract$",
      "-count=1",
      "-v",
    ],
    {
      cwd: path.resolve(process.cwd(), "../agent"),
      env: {
        ...process.env,
        FREE4CHAT_MCP_CONTRACT_ENDPOINT: "http://localhost:3000/mcp",
      },
      timeout: 170_000,
    }
  )
  expect(stdout).toContain("--- PASS: TestWorkerMCPContract")
  expect(stdout).not.toContain("--- SKIP:")
})

test("Worker preserves MCP protocol and Room origin enforcement", async ({
  request,
}) => {
  const headers = {
    Origin: "http://localhost:3000",
    "Mcp-Method": "tools/list",
    "MCP-Protocol-Version": "2026-07-28",
    Accept: "application/json",
  }
  const data = {
    jsonrpc: "2.0",
    id: 0,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }
  const listed = await request.post("/mcp", { headers, data })
  expect(listed.status()).toBe(200)
  const payload = await listed.json()
  expect(payload.result.tools).toHaveLength(20)
  expect(
    payload.result.tools.map((tool: { name: string }) => tool.name)
  ).toContain("join_room")
  const { "MCP-Protocol-Version": _version, ...missingHeader } = headers
  const rejected = await request.post("/mcp", { headers: missingHeader, data })
  expect(rejected.status()).toBe(400)
  const forbidden = await request.post("/api/sfu/session", {
    headers: { Origin: "https://untrusted.invalid" },
    data: { room: "migration-probe", name: "Probe" },
  })
  expect(forbidden.status()).toBe(403)
})
