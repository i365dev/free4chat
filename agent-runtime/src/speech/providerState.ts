import type { SpeechStore } from "./storage.js"
import { resolvedProviderValues, selectedProviderId } from "./storage.js"
import type {
  SpeechProviderDescriptor,
  SpeechProviderRegistry,
} from "./types.js"

export interface ResolvedSpeechProviderState {
  providerId?: string
  provider?: SpeechProviderDescriptor
  values: Record<string, string>
}

export async function resolveSpeechProviderState(
  registry: SpeechProviderRegistry,
  store: SpeechStore,
  environment: NodeJS.ProcessEnv
): Promise<ResolvedSpeechProviderState> {
  // An explicit selector is an advanced environment override and must remain
  // usable even when an old local config file is damaged.
  const explicitProviderId = environment.FREE4CHAT_STT_PROVIDER
  const config = explicitProviderId
    ? {}
    : await readSpeechStorage(() => store.readConfig())
  const providerId = selectedProviderId(config, environment)
  const provider = providerId ? registry.get(providerId) : undefined
  if (!provider) {
    // There is no provider to resolve, but still inspect the credentials file
    // so storage corruption is not silently reported as "unconfigured".
    if (!explicitProviderId)
      await readSpeechStorage(() => store.readCredentials())
    return { providerId, values: {} }
  }

  const environmentValues = resolvedProviderValues(
    provider,
    undefined,
    environment
  )
  if (explicitProviderId && hasRequiredValues(provider, environmentValues))
    return { providerId, provider, values: environmentValues }

  // A complete environment credential override is authoritative even when
  // the provider selector came from local config. This keeps an old damaged
  // credentials file from blocking a usable explicit credential.
  if (hasRequiredValues(provider, environmentValues))
    return { providerId, provider, values: environmentValues }

  const credentials = await readSpeechStorage(() => store.readCredentials())
  return {
    providerId,
    provider,
    values: resolvedProviderValues(
      provider,
      credentials.providers?.[provider.id],
      environment
    ),
  }
}

export async function readSpeechStorage<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch {
    throw new Error(
      "free4chat-agent speech storage is unavailable or malformed"
    )
  }
}

export function hasRequiredValues(
  provider: SpeechProviderDescriptor,
  values: Record<string, string>
): boolean {
  return provider.setupFields.every(
    (field) => !field.required || Boolean(values[field.key])
  )
}
