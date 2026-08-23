import type {
  SpeechProviderDescriptor,
  SpeechProviderRegistry,
} from "./types.js"
import { doubaoSpeechProvider } from "./providers/doubao/descriptor.js"

export class MutableSpeechProviderRegistry implements SpeechProviderRegistry {
  private readonly providers = new Map<string, SpeechProviderDescriptor>()

  register(provider: SpeechProviderDescriptor): void {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider.id))
      throw new Error("speech provider id is invalid")
    if (this.providers.has(provider.id))
      throw new Error(`speech provider ${provider.id} is already registered`)
    this.providers.set(provider.id, provider)
  }

  get(id: string): SpeechProviderDescriptor | undefined {
    return this.providers.get(id)
  }

  list(): readonly SpeechProviderDescriptor[] {
    return [...this.providers.values()]
  }
}

export function productionSpeechRegistry(): SpeechProviderRegistry {
  const registry = new MutableSpeechProviderRegistry()
  registry.register(doubaoSpeechProvider)
  return registry
}
