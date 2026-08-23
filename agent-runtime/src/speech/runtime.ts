import { LocalSpeechStore, type SpeechStore } from "./storage.js"
import { productionSpeechRegistry } from "./registry.js"
import {
  hasRequiredValues,
  resolveSpeechProviderState,
} from "./providerState.js"
import type { SpeechProviderRegistry } from "./types.js"
import {
  SpeechTranscriber,
  type AttributedSttEventHandler,
} from "./transcriber.js"

export interface SpeechRuntimeOptions {
  registry?: SpeechProviderRegistry
  store?: SpeechStore
  environment?: NodeJS.ProcessEnv
  onEvent?: AttributedSttEventHandler
}

/**
 * Resolve the same local/env provider state as the speech CLI. A missing or
 * malformed speech setup is intentionally allowed to reject this optional
 * capability without affecting the text Agent.
 */
export async function createConfiguredSpeechTranscriber(
  options: SpeechRuntimeOptions = {}
): Promise<SpeechTranscriber | null> {
  const registry = options.registry ?? productionSpeechRegistry()
  const store = options.store ?? new LocalSpeechStore()
  const environment = options.environment ?? process.env
  const state = await resolveSpeechProviderState(registry, store, environment)
  if (
    !state.provider ||
    !state.provider.createSttProvider ||
    !state.provider.capabilities.includes("stt") ||
    !hasRequiredValues(state.provider, state.values)
  )
    return null
  return new SpeechTranscriber({
    provider: state.provider.createSttProvider(state.values),
    onEvent: options.onEvent,
  })
}
