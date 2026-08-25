import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LocalSpeechStore,
  type SpeechConfig,
  type SpeechCredentials,
  type SpeechStore,
} from "../src/speech/storage.js"
import { resolveSpeechProviderState } from "../src/speech/providerState.js"
import {
  MutableSpeechProviderRegistry,
  productionSpeechRegistry,
} from "../src/speech/registry.js"
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

function ttsDescriptor(
  id: string,
  capabilities: SpeechProviderDescriptor["capabilities"]
): {
  descriptor: SpeechProviderDescriptor
  factories: FactoryCall[]
} {
  const factories: FactoryCall[] = []
  const descriptor: SpeechProviderDescriptor = {
    id,
    name: id,
    capabilities,
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
  const { descriptor, factories } = ttsDescriptor("dual", ["stt", "tts"])
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
  const { descriptor, factories } = ttsDescriptor("dual", ["stt", "tts"])
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
  const { descriptor, factories } = ttsDescriptor("dual", ["stt", "tts"])
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
  const { descriptor } = ttsDescriptor("dual", ["stt", "tts"])
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
  const { descriptor, factories } = ttsDescriptor("dual", ["stt", "tts"])
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
  const { descriptor, factories } = ttsDescriptor("dual", ["stt", "tts"])
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
  const { descriptor, factories } = ttsDescriptor("dual", ["stt", "tts"])
  const state = await resolveConfiguredTtsProvider({
    registry: registryWith([descriptor]),
    store: new FakeStore({ speech: { stt: { provider: "dual" } } }),
    environment: {},
  })
  assert.equal(state.tts ?? null, null)
  assert.equal(factories.length, 0)
})

test("one DOUBAO_API_KEY resolves Doubao STT and Doubao TTS side by side", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-doubao-both-"))
  try {
    await mkdir(directory, { recursive: true })
    const store = new LocalSpeechStore(directory)
    // One credential entry; two independent activation slots.
    await store.saveProvider(
      "doubao",
      { apiKey: "sk-one-key" },
      { slots: ["stt", "tts"] }
    )
    const config = await store.readConfig()
    assert.equal(config.speech?.stt?.provider, "doubao")
    assert.equal(config.speech?.tts?.provider, "doubao")

    const registry = productionSpeechRegistry()
    const sttState = await resolveSpeechProviderState(registry, store, {})
    assert.equal(sttState.providerId, "doubao")
    assert.equal(typeof sttState.provider?.createSttProvider, "function")

    const ttsState = await resolveConfiguredTtsProvider({
      registry,
      store,
      environment: {},
    })
    assert.equal(ttsState.providerId, "doubao")
    assert.ok(ttsState.tts)

    // The TTS resolution result never carries credential material (the
    // STT state intentionally exposes values to its factory callers).
    const serialized = JSON.stringify(ttsState)
    assert.ok(!serialized.includes("sk-one-key"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("activating only the tts slot leaves an existing stt selection untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-tts-only-"))
  try {
    await mkdir(directory, { recursive: true })
    const store = new LocalSpeechStore(directory)
    await store.saveProvider("doubao", { apiKey: "sk-existing-stt" })

    // A hypothetical tts-only selection path must not touch the stt slot.
    await store.saveProvider("doubao", { apiKey: "sk-tts" }, { slots: ["tts"] })

    const config = await store.readConfig()
    assert.equal(config.speech?.stt?.provider, "doubao")
    assert.equal(config.speech?.tts?.provider, "doubao")
    const credentials = await store.readCredentials()
    assert.equal(credentials.providers?.doubao?.apiKey, "sk-tts")

    const registry = productionSpeechRegistry()
    const sttState = await resolveSpeechProviderState(registry, store, {})
    assert.equal(sttState.providerId, "doubao")
    assert.equal(typeof sttState.provider?.createSttProvider, "function")
    const ttsState = await resolveConfiguredTtsProvider({
      registry,
      store,
      environment: {},
    })
    assert.equal(ttsState.providerId, "doubao")
    assert.ok(ttsState.tts)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("speech setup doubao activates both slots and both capabilities resolve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-setup-both-"))
  try {
    await mkdir(directory, { recursive: true })
    const store = new LocalSpeechStore(directory)
    const promptedFields: string[] = []
    let validated = 0
    const registry = new MutableSpeechProviderRegistry()
    const delegate = productionSpeechRegistry().get("doubao")!
    registry.register({
      ...delegate,
      // Offline stub: the real validate performs a live Doubao handshake.
      async validate() {
        validated += 1
        return { valid: true }
      },
    })

    await runSpeechCommand(["setup", "doubao"], {
      registry,
      store,
      input: {
        async read(field) {
          promptedFields.push(field.key)
          if (field.key === "apiKey") return "sk-fresh-key"
          return ""
        },
      },
      environment: {},
      stdout: () => undefined,
    })
    assert.ok(validated >= 1)

    const config = await store.readConfig()
    assert.equal(config.speech?.stt?.provider, "doubao")
    assert.equal(config.speech?.tts?.provider, "doubao")
    const credentials = await store.readCredentials()
    assert.equal(credentials.providers?.doubao?.apiKey, "sk-fresh-key")

    const resolvedRegistry = productionSpeechRegistry()
    const sttState = await resolveSpeechProviderState(
      resolvedRegistry,
      store,
      {}
    )
    assert.equal(sttState.providerId, "doubao")
    assert.equal(typeof sttState.provider?.createSttProvider, "function")
    const ttsState = await resolveConfiguredTtsProvider({
      registry: resolvedRegistry,
      store,
      environment: {},
    })
    assert.equal(ttsState.providerId, "doubao")
    assert.ok(ttsState.tts)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("speak-tts writes the synthesized PCM stream to the output file without leaking the key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speak-tts-"))
  try {
    const outPath = join(directory, "probe.pcm")
    const scripted: SpeechProviderDescriptor = {
      id: "scripted",
      name: "Scripted TTS",
      capabilities: ["tts"],
      setupFields: [],
      async validate() {
        return { valid: true }
      },
      async diagnose() {
        return { ready: true }
      },
      createTtsProvider() {
        return {
          async createSession() {
            return {
              async *synthesize(text: string) {
                for (const piece of text.split(/\s+/).filter(Boolean)) {
                  yield {
                    codec: "pcm_s16le",
                    sampleRateHz: 24_000,
                    channels: 1,
                    data: Buffer.from(`pcm:${piece}`, "utf8"),
                  }
                }
              },
              async close() {},
            }
          },
        }
      },
    }
    const output: string[] = []
    await runSpeechCommand(
      ["speak-tts", "--text", "one two", "--out", outPath],
      {
        registry: registryWith([scripted]),
        store: new FakeStore(
          { speech: { tts: { provider: "scripted" } } },
          {
            providers: { scripted: { apiKey: "sk-probe-secret" } },
          }
        ),
        environment: {},
        stdout: (line) => output.push(line),
      }
    )
    const written = await readFile(outPath)
    assert.equal(written.toString("utf8"), "pcm:onepcm:two")
    const printed = output.join("\n")
    assert.match(printed, /24000 Hz mono s16le/)
    assert.ok(printed.includes(outPath))
    assert.ok(!printed.includes("sk-probe-secret"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("speak-tts fails with setup guidance when no tts provider is configured", async () => {
  await assert.rejects(
    () =>
      runSpeechCommand(["speak-tts", "--text", "hi"], {
        registry: registryWith([]),
        store: new FakeStore(),
        environment: {},
        stdout: () => undefined,
      }),
    /no text-to-speech provider is configured/
  )
})
