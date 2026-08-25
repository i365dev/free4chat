import { OpenAiCompatibleTtsProvider } from "./openaiCompatible.js"
import type { SpeechProviderDescriptor } from "../../speech/types.js"

const SETUP_FIELDS = [
  {
    key: "apiKey",
    label: "API key",
    secret: true,
    required: true,
    environmentVariable: "OPENAI_API_KEY",
  },
  {
    key: "baseUrl",
    label: "Base URL",
    secret: false,
    environmentVariable: "OPENAI_TTS_BASE_URL",
  },
  {
    key: "model",
    label: "TTS model",
    secret: false,
    environmentVariable: "OPENAI_TTS_MODEL",
  },
  {
    key: "voice",
    label: "Voice",
    secret: false,
    environmentVariable: "OPENAI_TTS_VOICE",
  },
] as const

/**
 * BYOK text-to-speech against any OpenAI-compatible deployment (hosted or
 * a local server). Validation stays offline on purpose: unlike the Doubao
 * STT websocket handshake, every speech request bills per character, so
 * readiness is a credential-shape check rather than a paid probe.
 */
export const openAiCompatibleSpeechProvider: SpeechProviderDescriptor = {
  id: "openai-compatible",
  name: "OpenAI-compatible TTS",
  capabilities: ["tts"],
  setupFields: SETUP_FIELDS,
  async validate(values) {
    if (!values.apiKey?.trim())
      return { valid: false, message: "API key is required" }
    return { valid: true }
  },
  async diagnose(values) {
    if (!values.apiKey?.trim())
      return {
        ready: false,
        message: "API key is missing",
      }
    return { ready: true }
  },
  createTtsProvider(values) {
    return new OpenAiCompatibleTtsProvider(values)
  },
}
