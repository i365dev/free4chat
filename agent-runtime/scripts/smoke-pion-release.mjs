import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

import { ensurePionBinary } from "../dist/media/pionProvision.js"

const version = process.env.PION_SMOKE_VERSION
const platform = process.env.PION_SMOKE_OS
const arch = process.env.PION_SMOKE_ARCH
if (!version || !platform || !arch)
  throw new Error(
    "PION_SMOKE_VERSION, PION_SMOKE_OS and PION_SMOKE_ARCH are required"
  )

const cacheRoot = await mkdtemp(join(tmpdir(), "free4chat-pion-smoke-"))
try {
  const resolved = await ensurePionBinary({
    version,
    platform,
    arch,
    cacheRoot,
  })
  assert.equal(resolved.source, "download")
  assert.equal(resolved.version, version)
  assert.match(
    resolved.binPath,
    new RegExp(`pion-${version}-${platform}-${arch}$`)
  )
  assert.equal((await stat(resolved.binPath)).isFile(), true)

  await pingChild(resolved.binPath)

  const rejectedFetch = async () => {
    throw new Error("unexpected redownload")
  }
  const cached = await ensurePionBinary({
    version,
    platform,
    arch,
    cacheRoot,
    fetchImpl: rejectedFetch,
  })
  assert.equal(cached.source, "cache")
  assert.equal(cached.binPath, resolved.binPath)
  console.log(
    `Pion ${version} ${platform}-${arch}: download, checksum, ping and cache reuse passed`
  )
} finally {
  await rm(cacheRoot, { recursive: true, force: true })
}

function pingChild(binPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "ignore"] })
    let buffer = ""
    let settled = false
    const timeout = setTimeout(
      () => finish(new Error("Pion ping timed out")),
      5000
    )
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      if (error) reject(error)
      else resolve()
    }
    child.once("error", finish)
    child.once("exit", (code) => {
      if (!settled)
        finish(new Error(`Pion exited before ping response (${code})`))
    })
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, newline))
        assert.equal(response.id, 1)
        assert.equal(response.ok, true)
        child.stdin.write('{"id":2,"op":"close"}\n')
        finish()
      } catch (error) {
        finish(error)
      }
    })
    child.stdin.write('{"id":1,"op":"ping"}\n')
  })
}
