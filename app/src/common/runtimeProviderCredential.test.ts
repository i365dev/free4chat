import { describe, expect, it } from "vitest"

import {
  createRuntimeProviderClaim,
  deriveRuntimeProviderClaimHash,
  hashRuntimeProviderHandle,
  isRuntimeProviderSecret,
} from "./runtimeProviderCredential"

// This fixed vector is mirrored in agent/internal/types/runtime_provider.go.
// Both implementations hash UTF-8 `domain + NUL + room + NUL + secret` and
// encode the SHA-256 digest with unpadded base64url.
const VECTOR = {
  roomId: "room-176-provider",
  claimSecret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  claimHash: "KPvm-f4hBdYhSjdaYF_67xqPZx7BiiAXvMo1U_8l44w",
}

describe("Runtime provider credential protocol", () => {
  it("derives the shared Go/browser claim hash vector", async () => {
    await expect(
      deriveRuntimeProviderClaimHash(VECTOR.roomId, VECTOR.claimSecret)
    ).resolves.toBe(VECTOR.claimHash)
  })

  it("creates 256-bit opaque provider claims", async () => {
    const claim = await createRuntimeProviderClaim("room-176-provider")
    expect(isRuntimeProviderSecret(claim.providerClaimSecret)).toBe(true)
    expect(claim.providerClaimHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("domain-separates handle verification material from claim hashes", async () => {
    await expect(
      hashRuntimeProviderHandle(
        VECTOR.roomId,
        "host-176-provider",
        VECTOR.claimSecret
      )
    ).resolves.not.toBe(VECTOR.claimHash)
  })
})
