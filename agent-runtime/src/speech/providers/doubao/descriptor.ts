import { DoubaoProviderError, DoubaoSttProvider } from "./provider.js"
import { DoubaoTtsProvider } from "./ttsProvider.js"
import type { SpeechProviderDescriptor } from "../../types.js"

const API_KEY_FIELD = {
  key: "apiKey",
  label: "Doubao X-API-Key",
  secret: true,
  required: true,
  environmentVariable: "DOUBAO_API_KEY",
} as const

const VOICE_FIELD = {
  key: "voice",
  label: "Doubao TTS 2.0 voice",
  secret: false,
  environmentVariable: "DOUBAO_TTS_VOICE",
} as const

/**
 * One Doubao console credential powers both speech capabilities of the
 * resident Runtime: Streaming ASR 2.0 (Meeting Notes ingress) and Speech
 * Synthesis 2.0 (outbound voice, V3 output-unidirectional interface,
 * resource id seed-tts-2.0). The two selections stay in their own config
 * slots; the credential entry and its env override are shared.
 */
export const doubaoSpeechProvider: SpeechProviderDescriptor = {
  id: "doubao",
  name: "Doubao Speech 2.0 (Streaming ASR + TTS)",
  capabilities: ["stt", "tts"],
  setupFields: [API_KEY_FIELD, VOICE_FIELD],
  async validate(values) {
    return probe(values)
  },
  async diagnose(values) {
    const result = await probe(values)
    return {
      ready: result.valid,
      ...(result.message ? { message: result.message } : {}),
    }
  },
  createSttProvider(values) {
    return new DoubaoSttProvider(values.apiKey ?? "")
  },
  createTtsProvider(values) {
    return new DoubaoTtsProvider(values.apiKey ?? "", {
      voice: values.voice,
    })
  },
}

async function probe(
  values: Record<string, string>
): Promise<{ valid: boolean; message?: string }> {
  const apiKey = values.apiKey?.trim()
  if (!apiKey) return { valid: false, message: "Doubao X-API-Key is required" }
  try {
    const session = await new DoubaoSttProvider(apiKey).createSession()
    await session.close()
    return { valid: true }
  } catch (error) {
    // Never forward provider response bodies, URLs, or credentials into the
    // CLI. Setup and doctor share the same sanitized contract.
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
