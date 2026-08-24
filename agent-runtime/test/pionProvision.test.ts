import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import {
  detectPionPlatform,
  ensurePionBinary,
  pionAssetName,
  probePionBinary,
  PionProvisionError,
} from "../src/media/pionProvision.js"

const VERSION = "0.2.0"

test("detectPionPlatform maps darwin/linux arm64/x64 and rejects others", () => {
  assert.deepEqual(detectPionPlatform("darwin", "arm64"), {
    os: "darwin",
    arch: "arm64",
  })
  assert.deepEqual(detectPionPlatform("linux", "x64"), {
    os: "linux",
    arch: "x64",
  })
  assert.equal(detectPionPlatform("win32", "x64"), null)
})

test("developer override wins over cache/download and must exist", async () => {
  const ready = await probePionBinary({
    binOverride: "/tmp/fake-pion-bin",
  })
  assert.equal(ready.ready, false)
  assert.match(ready.reason ?? "", /does not exist/)

  await assert.rejects(
    ensurePionBinary({ binOverride: "/tmp/fake-pion-bin-missing" }),
    (e: unknown) =>
      e instanceof PionProvisionError && e.code === "pion_provision_failed"
  )
})

test("unsupported platform yields a typed actionable error", async () => {
  await assert.rejects(
    ensurePionBinary({ platform: "win32", arch: "x64", version: VERSION }),
    (e: unknown) =>
      e instanceof PionProvisionError &&
      e.code === "pion_platform_unsupported" &&
      /No prebuilt Pion engine/.test(e.message)
  )
})

test("downloads version-matched binary, verifies checksum, caches atomically", async () => {
  const bytes = Buffer.from("#!/bin/sh\necho pion\n")
  const assetName = pionAssetName(VERSION, { os: "darwin", arch: "arm64" })
  const sha = createHash("sha256").update(bytes).digest("hex")
  const urls: string[] = []

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith(`/${assetName}`)) return new Response(bytes)
    if (url.endsWith("/SHA256SUMS"))
      return new Response(`${sha}  ${assetName}\n`)
    throw new Error(`unexpected url ${url}`)
  }) as typeof fetch

  const cacheRoot = `/tmp/free4chat-pion-test/${Math.random().toString(36).slice(2)}`
  const resolved = await ensurePionBinary({
    version: VERSION,
    platform: "darwin",
    arch: "arm64",
    cacheRoot,
    fetchImpl,
  })

  assert.equal(resolved.source, "download")
  assert.equal(resolved.version, VERSION)
  assert.ok(resolved.binPath.startsWith(cacheRoot))
  assert.ok(urls.some((u) => u.includes(`pion-v${VERSION}/`)))

  // Cache reuse: a second resolve with a fetchImpl that must never be called.
  const rejectedFetch = (async () => {
    throw new Error("must not download when cached")
  }) as unknown as typeof fetch
  const again = await ensurePionBinary({
    version: VERSION,
    platform: "darwin",
    arch: "arm64",
    cacheRoot,
    fetchImpl: rejectedFetch,
  })
  assert.equal(again.source, "cache")
  assert.equal(again.binPath, resolved.binPath)
})

test("checksum mismatch leaves no ready binary behind", async () => {
  const bytes = Buffer.from("real-bytes")
  const assetName = pionAssetName(VERSION, {
    os: "linux",
    arch: "amd64" as never,
  })
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/SHA256SUMS"))
      return new Response(`deadbeef  ${assetName}\n`)
    return new Response(bytes)
  }) as typeof fetch

  const cacheRoot = `/tmp/free4chat-pion-test/bad-${Math.random()
    .toString(36)
    .slice(2)}`
  await assert.rejects(
    ensurePionBinary({
      version: VERSION,
      platform: "linux",
      arch: "x64",
      cacheRoot,
      fetchImpl,
    }),
    (e: unknown) =>
      e instanceof PionProvisionError && e.code === "pion_checksum_failed"
  )
})

test("truncated download fails the checksum instead of becoming ready", async () => {
  const full = Buffer.from("complete-binary-content")
  const assetName = pionAssetName(VERSION, { os: "linux", arch: "x64" })
  const sha = createHash("sha256").update(full).digest("hex")
  const truncated = full.subarray(0, full.length - 3)

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/SHA256SUMS"))
      return new Response(`${sha}  ${assetName}\n`)
    return new Response(truncated)
  }) as typeof fetch

  await assert.rejects(
    ensurePionBinary({
      version: VERSION,
      platform: "linux",
      arch: "x64",
      cacheRoot: "/tmp/free4chat-pion-test/truncated",
      fetchImpl,
    }),
    (e: unknown) =>
      e instanceof PionProvisionError && e.code === "pion_checksum_failed"
  )
})
