import assert from "node:assert/strict"
import { test } from "node:test"

import type {
  SpeechConfig,
  SpeechCredentials,
  SpeechStore,
} from "../src/speech/storage.js"
import type {
  SpeechProviderDescriptor,
  SpeechProviderRegistry,
} from "../src/speech/types.js"
import { resolveConfiguredTtsProvider } from "../src/voice/ttsProvider.js"

class FakeStore implements SpeechStore {
  constructor(
    private readonly config: SpeechConfig = {},
    private readonly credentials: SpeechCredentials = {}
  ) {}
  async readConfig(): Promise<SpeechConfig> {
    return this.config
  }
  async readCredentials(): Promise<SpeechCredentials> {
    return this.credentials
  }
  async saveProvider(): Promise<void> {}
}

function registryWith(
  providers: SpeechProviderDescriptor[]
): SpeechProviderRegistry {
  const map = new Map(providers.map((provider) => [provider.id, provider]))
  return {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  }
}

interface FactoryCall {
  values: Record<string, string>
}

function ttsDescriptor(id: string): {
  descriptor: SpeechProviderDescriptor
  factories: FactoryCall[]
} {
  const factories: FactoryCall[] = []
  const descriptor: SpeechProviderDescriptor = {
    id,
    name: id,
    capabilities: ["stt", "tts"],
    setupFields: [
      {
        key: "apiKey",
        label: "API key",
        secret: true,
        required: true,
        environmentVariable: "FAKE_TTS_API_KEY",
      },
    ],
    async validate() {
      return { valid: true }
    },
    async diagnose() {
      return { ready: true }
    },
    createTtsProvider(values) {
      factories.push({ values })
      return {} as ReturnType<
        NonNullable<SpeechProviderDescriptor["createTtsProvider"]>
      >
    },
  }
  return { descriptor, factories }
}

const STT_ONLY: SpeechProviderDescriptor = {
  id: "sttonly",
  name: "STT only",
  capabilities: ["stt"],
  setupFields: [
    { key: "apiKey", label: "API key", secret: true, required: true },
  ],
  async validate() {
    return { valid: true }
  },
  async diagnose() {
    return { ready: true }
  },
}

test("returns nothing when nothing is configured", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore(),
    environment: {},
  })
  assert.equal(state.providerId, undefined)
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})

test("stored selection without tts capability yields no factory", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor, STT_ONLY]),
    store: new FakeStore({
      speech: { stt: { provider: "sttonly" } },
    }),
    environment: {},
  })
  assert.equal(state.providerId, "sttonly")
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})

test("environment override selects a tts-capable provider with env credentials", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore({
      speech: { stt: { provider: "sttonly" } },
    }),
    environment: {
      FREE4CHAT_TTS_PROVIDER: "dual",
      FAKE_TTS_API_KEY: "sk-env",
    },
  })
  assert.equal(state.providerId, "dual")
  assert.ok(state.tts)
  assert.deepEqual(factories[0]?.values, { apiKey: "sk-env" })
})

test("explicit override naming a non-tts provider stays disabled", async () => {
  const { descriptor } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor, STT_ONLY]),
    store: new FakeStore(
      { speech: { stt: { provider: "dual" } } },
      { providers: { dual: { apiKey: "sk-stored" } } }
    ),
    environment: { FREE4CHAT_TTS_PROVIDER: "sttonly" },
  })
  assert.equal(state.providerId, "sttonly")
  assert.equal(state.tts ?? null, null)
})

test("stored credentials reach the factory; secrets stay inside values", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore(
      { speech: { stt: { provider: "dual" } } },
      { providers: { dual: { apiKey: "sk-stored" } } }
    ),
    environment: {},
  })
  assert.equal(state.providerId, "dual")
  assert.ok(state.tts)
  assert.deepEqual(factories[0]?.values, { apiKey: "sk-stored" })
  // The resolved state itself never carries credential material.
  const serialized = JSON.stringify(state)
  assert.ok(!serialized.includes("sk-stored"))
})

test("missing required values disable voice without touching other capabilities", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore({ speech: { stt: { provider: "dual" } } }),
    environment: {},
  })
  assert.equal(state.providerId, "dual")
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})
