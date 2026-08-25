import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LocalSpeechStore,
  type SpeechConfig,
  type SpeechCredentials,
  type SpeechStore,
} from "../src/speech/storage.js"
import { resolveSpeechProviderState } from "../src/speech/providerState.js"
import { productionSpeechRegistry } from "../src/speech/registry.js"
import { runSpeechCommand } from "../src/speech/cli.js"
import type {
  SpeechProviderDescriptor,
  SpeechProviderRegistry,
  StreamingTtsProvider,
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
      return {} as StreamingTtsProvider
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

test("a stored tts-slot selection without tts capability yields no factory", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor, STT_ONLY]),
    store: new FakeStore({
      speech: { tts: { provider: "sttonly" } },
    }),
    environment: {},
  })
  assert.equal(state.providerId, "sttonly")
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})

test("environment override wins over a non-tts stored tts-slot selection", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore({
      speech: { tts: { provider: "sttonly" } },
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
      { speech: { tts: { provider: "dual" } } },
      { providers: { dual: { apiKey: "sk-stored" } } }
    ),
    environment: { FREE4CHAT_TTS_PROVIDER: "sttonly" },
  })
  assert.equal(state.providerId, "sttonly")
  assert.equal(state.tts ?? null, null)
})

test("stored tts-slot credentials reach the factory; secrets stay inside values", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore(
      { speech: { tts: { provider: "dual" } } },
      { providers: { dual: { apiKey: "sk-stored" } } }
    ),
    environment: {},
  })
  assert.equal(state.providerId, "dual")
  assert.ok(state.tts)
  assert.deepEqual(factories[0]?.values, { apiKey: "sk-stored" })
  const serialized = JSON.stringify(state)
  assert.ok(!serialized.includes("sk-stored"))
})

test("missing required values disable voice without touching other capabilities", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore({ speech: { tts: { provider: "dual" } } }),
    environment: {},
  })
  assert.equal(state.providerId, "dual")
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})

test("the stt slot alone never activates tts resolution", async () => {
  const { descriptor, factories } = ttsDescriptor("dual")
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore({ speech: { stt: { provider: "dual" } } }),
    environment: {},
  })
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})

test("doubao STT and openai-compatible TTS stay independently selected and resolvable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-tts-both-"))
  try {
    await mkdir(directory, { recursive: true })
    const store = new LocalSpeechStore(directory)
    // Default save keeps activating through the historical stt slot...
    await store.saveProvider("doubao", { apiKey: "sk-stt-key" })
    // ...while the tts slot is written explicitly alongside it.
    await store.saveProvider(
      "openai-compatible",
      { apiKey: "sk-tts-key" },
      { slot: "tts" }
    )
    const config = await store.readConfig()
    assert.equal(config.speech?.stt?.provider, "doubao")
    assert.equal(config.speech?.tts?.provider, "openai-compatible")

    const registry = productionSpeechRegistry()
    const sttState = await resolveSpeechProviderState(registry, store, {})
    assert.equal(sttState.providerId, "doubao")
    assert.equal(typeof sttState.provider?.createSttProvider, "function")

    const ttsState = await resolveConfiguredTtsProvider({
      registry,
      store,
      environment: {},
    })
    assert.equal(ttsState.providerId, "openai-compatible")
    assert.ok(ttsState.tts)

    // The TTS resolution result never carries credential material (the
    // STT state intentionally exposes values to its factory callers).
    const serialized = JSON.stringify(ttsState)
    assert.ok(!serialized.includes("sk-tts-key"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("tts-only setup routes into the tts slot and leaves an existing stt selection untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-tts-setup-"))
  try {
    await mkdir(directory, { recursive: true })
    const store = new LocalSpeechStore(directory)
    await store.saveProvider("doubao", { apiKey: "sk-existing-stt" })

    const promptedFields: string[] = []
    await runSpeechCommand(["setup", "openai-compatible"], {
      registry: productionSpeechRegistry(),
      store,
      input: {
        async read(field) {
          promptedFields.push(field.key)
          return field.key === "apiKey" ? "sk-fresh-tts" : ""
        },
      },
      environment: {},
      stdout: () => undefined,
    })

    const config = await store.readConfig()
    assert.equal(config.speech?.stt?.provider, "doubao")
    assert.equal(config.speech?.tts?.provider, "openai-compatible")
    const credentials = await store.readCredentials()
    assert.equal(credentials.providers?.doubao?.apiKey, "sk-existing-stt")
    assert.equal(
      credentials.providers?.["openai-compatible"]?.apiKey,
      "sk-fresh-tts"
    )
    assert.deepEqual([...new Set(promptedFields)].sort(), [
      "apiKey",
      "baseUrl",
      "model",
      "voice",
    ])
    const apiKeyPrompts = promptedFields.filter((key) => key === "apiKey")
    assert.equal(apiKeyPrompts.length, 1)

    // Both capabilities still resolve exactly as before the TTS-only setup.
    const registry = productionSpeechRegistry()
    const sttState = await resolveSpeechProviderState(registry, store, {})
    assert.equal(sttState.providerId, "doubao")
    assert.equal(typeof sttState.provider?.createSttProvider, "function")
    const ttsState = await resolveConfiguredTtsProvider({
      registry,
      store,
      environment: {},
    })
    assert.equal(ttsState.providerId, "openai-compatible")
    assert.ok(ttsState.tts)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
