import { DoubaoProviderError, DoubaoSttProvider } from "./provider.js"
import type { SpeechProviderDescriptor } from "../../types.js"

const API_KEY_FIELD = {
  key: "apiKey",
  label: "Doubao X-API-Key",
  secret: true,
  required: true,
  environmentVariable: "DOUBAO_API_KEY",
} as const

export const doubaoSpeechProvider: SpeechProviderDescriptor = {
  id: "doubao",
  name: "Doubao Streaming ASR 2.0",
  capabilities: ["stt"],
  setupFields: [API_KEY_FIELD],
  async validate(values) {
    return probe(values, "validation")
  },
  async diagnose(values) {
    const result = await probe(values, "diagnosis")
    return {
      ready: result.valid,
      ...(result.message ? { message: result.message } : {}),
    }
  },
  createSttProvider(values) {
    return new DoubaoSttProvider(values.apiKey ?? "")
  },
}

async function probe(
  values: Record<string, string>,
  operation: "validation" | "diagnosis"
): Promise<{ valid: boolean; message?: string }> {
  const apiKey = values.apiKey?.trim()
  if (!apiKey) return { valid: false, message: "Doubao X-API-Key is required" }
  try {
    const session = await new DoubaoSttProvider(apiKey).createSession()
    await session.close()
    return { valid: true }
  } catch (error) {
    // Never forward provider response bodies, URLs, or credentials into the
    // CLI. The operation name is intentionally not included in the public
    // message because setup and doctor need the same sanitized contract.
    void operation
    return {
      valid: false,
      message: sanitizeProbeError(error),
    }
  }
}

function sanitizeProbeError(error: unknown): string {
  if (error instanceof DoubaoProviderError && error.message.length <= 160)
    return `Doubao readiness probe failed: ${error.message}`
  return "Doubao readiness probe failed"
}
