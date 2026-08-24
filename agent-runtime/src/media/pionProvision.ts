import { createHash } from "node:crypto"
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { RUNTIME_PACKAGE_VERSION } from "../bootstrap.js"
import { runtimeDirectory } from "../core/paths.js"

/**
 * Pion media-engine binary provisioning (#105).
 *
 * Distribution contract: GitHub Release tag `pion-v<runtime version>` on
 * i365dev/free4chat carries one raw binary per supported platform plus a
 * SHA256SUMS manifest. The runtime downloads, verifies and caches the
 * matching asset lazily — the first time realtime media is actually needed.
 * A text-only room join never touches this module's network path.
 */

export type PionOs = "darwin" | "linux"
export type PionArch = "arm64" | "x64"

export interface PionPlatform {
  os: PionOs
  arch: PionArch
}

export class PionProvisionError extends Error {
  constructor(
    readonly code:
      | "pion_platform_unsupported"
      | "pion_provision_failed"
      | "pion_checksum_failed",
    message: string
  ) {
    super(message)
    this.name = "PionProvisionError"
  }
}

const SUPPORTED_PLATFORMS: PionPlatform[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
]

export function detectPionPlatform(
  platform: string = process.platform,
  arch: string = process.arch
): PionPlatform | null {
  const match = SUPPORTED_PLATFORMS.find(
    (candidate) => candidate.os === platform && candidate.arch === arch
  )
  return match ?? null
}

export function pionAssetName(version: string, platform: PionPlatform): string {
  return `pion-${version}-${platform.os}-${platform.arch}`
}

export function pionReleaseBaseUrl(
  version: string,
  repository = "i365dev/free4chat"
): string {
  return `https://github.com/${repository}/releases/download/pion-v${version}`
}

export function defaultPionCacheRoot(): string {
  return join(runtimeDirectory(), "media")
}

export interface EnsurePionBinaryOptions {
  /** Developer override (FREE4CHAT_PION_BIN): wins over everything. */
  binOverride?: string
  /** Defaults to <agent dir>/media */
  cacheRoot?: string
  /** Defaults to the runtime package version. */
  version?: string
  platform?: string
  arch?: string
  /** Injectable downloader for deterministic tests. */
  fetchImpl?: typeof fetch
  releaseBaseUrlOverride?: string
}

export type PionBinarySource = "override" | "cache" | "download"

export interface ResolvedPionBinary {
  binPath: string
  source: PionBinarySource
  version: string
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

function parseChecksumFor(
  checksumsText: string,
  assetName: string
): string | null {
  for (const rawLine of checksumsText.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    // Standard sha256sum format: "<hex>  <filename>"
    const [hex, name] = line.split(/\s+/)
    if (name === assetName && /^[0-9a-f]{64}$/.test(hex ?? "")) return hex
  }
  return null
}

async function downloadBytes(
  url: string,
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  const response = await fetchImpl(url)
  if (!response.ok)
    throw new PionProvisionError(
      "pion_provision_failed",
      `download failed: HTTP ${response.status} for ${url}`
    )
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Resolves the matching Pion engine binary without any network I/O:
 * developer override first, then the version-matched cache entry.
 * Readiness checks use this to report state without downloading.
 */
export async function probePionBinary(
  options: EnsurePionBinaryOptions = {}
): Promise<{ ready: boolean; binPath?: string; reason?: string }> {
  const platform = detectPionPlatform(options.platform, options.arch)
  if (options.binOverride) {
    const exists = await isExecutableFile(options.binOverride)
    if (!exists)
      return {
        ready: false,
        reason: `FREE4CHAT_PION_BIN does not exist: ${options.binOverride}`,
      }
    return { ready: true, binPath: options.binOverride }
  }
  if (!platform)
    return {
      ready: false,
      reason: `unsupported platform ${options.platform ?? process.platform}/${options.arch ?? process.arch}`,
    }
  const version = options.version ?? RUNTIME_PACKAGE_VERSION
  const binPath = join(
    options.cacheRoot ?? defaultPionCacheRoot(),
    `pion-${version}`,
    pionAssetName(version, platform)
  )
  if (await isExecutableFile(binPath)) return { ready: true, binPath }
  return { ready: false, reason: "not_provisioned" }
}

/**
 * Ensures a usable Pion engine binary: override → cached → download +
 * checksum-verify into the version-scoped cache. Never leaves a partial or
 * checksum-failed file behind as ready.
 */
export async function ensurePionBinary(
  options: EnsurePionBinaryOptions = {}
): Promise<ResolvedPionBinary> {
  if (options.binOverride) {
    if (!(await isExecutableFile(options.binOverride)))
      throw new PionProvisionError(
        "pion_provision_failed",
        `FREE4CHAT_PION_BIN does not exist: ${options.binOverride}`
      )
    return {
      binPath: options.binOverride,
      source: "override",
      version: options.version ?? RUNTIME_PACKAGE_VERSION,
    }
  }

  const platform = detectPionPlatform(options.platform, options.arch)
  if (!platform)
    throw new PionProvisionError(
      "pion_platform_unsupported",
      `No prebuilt Pion engine for ${options.platform ?? process.platform}/${options.arch ?? process.arch}. Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64.`
    )

  const probe = await probePionBinary(options)
  if (probe.ready && probe.binPath)
    return {
      binPath: probe.binPath,
      source: "cache",
      version: options.version ?? RUNTIME_PACKAGE_VERSION,
    }

  const version = options.version ?? RUNTIME_PACKAGE_VERSION
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const assetName = pionAssetName(version, platform)
  const baseUrl =
    options.releaseBaseUrlOverride ??
    process.env.FREE4CHAT_PION_RELEASE_BASE_URL ??
    `https://github.com/i365dev/free4chat/releases/download/pion-v${version}`

  let binaryBytes: Uint8Array
  try {
    binaryBytes = await downloadBytes(`${baseUrl}/${assetName}`, fetchImpl)

    const sumsUrl = `${baseUrl}/SHA256SUMS`
    const sumsResponse = await fetchImpl(sumsUrl)
    if (!sumsResponse.ok)
      throw new PionProvisionError(
        "pion_checksum_failed",
        `SHA256SUMS unavailable: HTTP ${sumsResponse.status}`
      )
    const expected = parseChecksumFor(await sumsResponse.text(), assetName)
    const actual = sha256Hex(binaryBytes)
    if (!expected || expected !== actual)
      throw new PionProvisionError(
        "pion_checksum_failed",
        expected
          ? `checksum mismatch for ${assetName}`
          : `checksum manifest has no entry for ${assetName}`
      )
  } catch (error) {
    if (error instanceof PionProvisionError) throw error
    throw new PionProvisionError(
      "pion_provision_failed",
      error instanceof Error ? error.message : String(error)
    )
  }

  const cacheRoot = options.cacheRoot ?? defaultPionCacheRoot()
  const versionDir = join(cacheRoot, `pion-${version}`)
  await mkdir(versionDir, { recursive: true })
  const finalPath = join(versionDir, assetName)
  const tmpPath = `${finalPath}.tmp-${process.pid}`
  await writeFile(tmpPath, binaryBytes)
  await chmod(tmpPath, 0o755)
  await rename(tmpPath, finalPath)
  return { binPath: finalPath, source: "download", version }
}
