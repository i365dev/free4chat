// Runtime-provider credentials are Room-scoped bearer capabilities. The
// secret itself never enters Room state; only these one-way, domain-separated
// hashes are sent to the Room coordinator.
export const RUNTIME_PROVIDER_CLAIM_DOMAIN = "free4chat-runtime-provider-v1"
export const RUNTIME_PROVIDER_HANDLE_DOMAIN =
  "free4chat-runtime-provider-handle-v1"

const RAW_SECRET_BYTES = 32
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!BASE64URL_256_PATTERN.test(value)) return undefined
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=")
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    )
    return bytes.length === RAW_SECRET_BYTES ? bytes : undefined
  } catch {
    return undefined
  }
}

function material(domain: string, fields: string[]): Uint8Array {
  // NUL delimiters make the protocol unambiguous while keeping the exact
  // browser/Worker/Go preimage easy to audit and reproduce.
  return new TextEncoder().encode(`${domain}\0${fields.join("\0")}`)
}

async function sha256Base64Url(
  domain: string,
  fields: string[]
): Promise<string> {
  const input = material(domain, fields)
  // Copy into an actual ArrayBuffer: TypeScript's newer typed-array lib
  // permits SharedArrayBuffer backing stores while WebCrypto's BufferSource
  // declaration here deliberately accepts only ArrayBuffer-backed bytes.
  const buffer = new ArrayBuffer(input.byteLength)
  new Uint8Array(buffer).set(input)
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return bytesToBase64Url(new Uint8Array(digest))
}

export function isRuntimeProviderClaimHash(value: unknown): value is string {
  return typeof value === "string" && BASE64URL_256_PATTERN.test(value)
}

export function isRuntimeProviderSecret(value: unknown): value is string {
  return typeof value === "string" && base64UrlToBytes(value) !== undefined
}

export function createRuntimeProviderSecret(): string {
  const bytes = new Uint8Array(RAW_SECRET_BYTES)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

// A provider handle has the same 256-bit bearer shape as a claim, but a
// different hash domain and lifecycle. Keeping the constructor named makes
// call sites less likely to confuse the two capabilities.
export function createRuntimeProviderHandle(): string {
  return createRuntimeProviderSecret()
}

export async function deriveRuntimeProviderClaimHash(
  roomId: string,
  providerClaimSecret: string
): Promise<string> {
  if (!roomId || !isRuntimeProviderSecret(providerClaimSecret))
    throw new Error("invalid_runtime_provider_claim")
  return sha256Base64Url(RUNTIME_PROVIDER_CLAIM_DOMAIN, [
    roomId,
    providerClaimSecret,
  ])
}

export async function createRuntimeProviderClaim(roomId: string): Promise<{
  providerClaimSecret: string
  providerClaimHash: string
}> {
  const providerClaimSecret = createRuntimeProviderSecret()
  return {
    providerClaimSecret,
    providerClaimHash: await deriveRuntimeProviderClaimHash(
      roomId,
      providerClaimSecret
    ),
  }
}

export async function hashRuntimeProviderHandle(
  roomId: string,
  runtimeHostId: string,
  runtimeProviderHandle: string
): Promise<string> {
  if (
    !roomId ||
    !runtimeHostId ||
    !isRuntimeProviderSecret(runtimeProviderHandle)
  )
    throw new Error("invalid_runtime_provider_handle")
  return sha256Base64Url(RUNTIME_PROVIDER_HANDLE_DOMAIN, [
    roomId,
    runtimeHostId,
    runtimeProviderHandle,
  ])
}
