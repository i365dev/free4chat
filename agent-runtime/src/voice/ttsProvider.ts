import {
  hasRequiredValues,
  readSpeechStorage,
} from "../speech/providerState.js"
import { resolvedProviderValues, type SpeechConfig } from "../speech/storage.js"
import type { SpeechStore } from "../speech/storage.js"
import type {
  SpeechProviderRegistry,
  StreamingTtsProvider,
} from "../speech/types.js"

export interface ResolvedTtsProviderState {
  providerId?: string
  tts?: StreamingTtsProvider | null
}

/**
 * Resolves the locally-configured BYOK TTS provider from the same local
 * credential storage as STT (#88/#105), with its own selection slot:
 * FREE4CHAT_TTS_PROVIDER override, then config `speech.tts.provider`. The
 * slots are independent by design (#83 review) — a TTS selection must
 * never displace or depend on `speech.stt.provider`. A selection only
 * yields a factory when its descriptor advertises the "tts" capability
 * and all required values are present. Secrets live solely in the values
 * handed to the provider constructor — never returned, logged, or
 * persisted anywhere else.
 */
export async function resolveConfiguredTtsProvider(options: {
  registry: SpeechProviderRegistry
  store: SpeechStore
  environment: NodeJS.ProcessEnv
}): Promise<ResolvedTtsProviderState> {
  const { registry, store, environment } = options
  const config = await readSpeechStorage(() => store.readConfig())
  const providerId = selectedTtsProviderId(config, environment)
  if (!providerId) return {}
  const provider = registry.get(providerId)
  if (!provider?.createTtsProvider || !provider.capabilities.includes("tts"))
    return { providerId }
  const credentials = await readSpeechStorage(() => store.readCredentials())
  const values = resolvedProviderValues(
    provider,
    credentials.providers?.[providerId],
    environment
  )
  if (!hasRequiredValues(provider, values)) return { providerId }
  return { providerId, tts: provider.createTtsProvider(values) }
}

function selectedTtsProviderId(
  config: SpeechConfig,
  environment: NodeJS.ProcessEnv
): string | undefined {
  const overridden = environment.FREE4CHAT_TTS_PROVIDER?.trim()
  if (overridden) return overridden
  const configured = config.speech?.tts?.provider
  return typeof configured === "string" ? configured : undefined
}
