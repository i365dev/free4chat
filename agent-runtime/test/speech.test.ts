import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import type { AudioFrame } from "../src/media/types.js"
import {
  MutableSpeechProviderRegistry,
  productionSpeechRegistry,
} from "../src/speech/registry.js"
import { runSpeechCommand } from "../src/speech/cli.js"
import { LocalSpeechStore } from "../src/speech/storage.js"
import type {
  SpeechProviderDescriptor,
  SpeechStore,
  StreamingSttProvider,
  StreamingSttSession,
  SttEvent,
} from "../src/speech/types.js"

class MemoryStore implements SpeechStore {
  config: { speech?: { stt?: { provider?: string } } } = {}
  credentials: { providers?: Record<string, Record<string, string>> } = {}

  async readConfig() {
    return this.config
  }
  async readCredentials() {
    return this.credentials
  }
  async saveProvider(providerId: string, values: Record<string, string>) {
    this.credentials = { providers: { [providerId]: { ...values } } }
    this.config = { speech: { stt: { provider: providerId } } }
  }
}

function fakeProvider(
  calls: { validate: number; diagnose: number },
  expectedSecret = "secret-sentinel"
): SpeechProviderDescriptor {
  return {
    id: "fake",
    name: "Deterministic Fake",
    capabilities: ["stt"],
    setupFields: [
      {
        key: "token",
        label: "Fake provider token",
        secret: true,
        required: true,
        environmentVariable: "FREE4CHAT_FAKE_TOKEN",
      },
    ],
    async validate(values) {
      calls.validate += 1
      return values.token === expectedSecret
        ? { valid: true }
        : { valid: false, message: `invalid token ${values.token}` }
    },
    async diagnose(values) {
      calls.diagnose += 1
      return { ready: values.token === expectedSecret }
    },
  }
}

test("fake STT provider registers and its session consumes semantic audio events", async () => {
  const audio: AudioFrame[] = []
  const events: SttEvent[] = [
    { type: "speech_started" },
    { type: "partial", text: "hel" },
    { type: "committed", text: "hello" },
    { type: "speech_ended" },
  ]
  let closed = 0
  const session: StreamingSttSession = {
    async pushAudio(frame) {
      audio.push(frame)
    },
    async *events() {
      yield* events
    },
    async close() {
      closed += 1
    },
  }
  const provider: StreamingSttProvider = {
    async createSession() {
      return session
    },
  }
  const registry = new MutableSpeechProviderRegistry()
  registry.register({
    ...fakeProvider({ validate: 0, diagnose: 0 }),
    createSttProvider: () => provider,
  })
  const created = registry.get("fake")?.createSttProvider?.({})
  assert.equal(created, provider)
  const createdSession = await provider.createSession()
  await createdSession.pushAudio({
    codec: "opus",
    sampleRateHz: 48000,
    channels: 2,
    timestampMs: 0,
    data: new Uint8Array([1]),
  })
  assert.equal(audio.length, 1)
  assert.deepEqual(
    [
      ...(await (async () => {
        const result: SttEvent[] = []
        for await (const event of session.events()) result.push(event)
        return result
      })()),
    ].map((event) => event.type),
    ["speech_started", "partial", "committed", "speech_ended"]
  )
  await createdSession.close()
  await createdSession.close()
  assert.equal(closed, 2)
})

test("production speech registry exposes Doubao with the local X-API-Key setup contract", () => {
  const provider = productionSpeechRegistry().get("doubao")
  assert.ok(provider)
  assert.deepEqual(provider.setupFields, [
    {
      key: "apiKey",
      label: "Doubao X-API-Key",
      secret: true,
      required: true,
      environmentVariable: "DOUBAO_API_KEY",
    },
  ])
  assert.equal(provider.capabilities.includes("stt"), true)
  assert.equal(typeof provider.createSttProvider, "function")
})

test("local speech storage uses a private directory, private credentials, and atomic replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speech-"))
  const store = new LocalSpeechStore(directory)
  await store.saveProvider("fake", { token: "old-secret" })

  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal(
    (await stat(join(directory, "credentials.json"))).mode & 0o777,
    0o600
  )
  assert.equal((await stat(join(directory, "config.json"))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(directory), [
    "config.json",
    "credentials.json",
  ])
  assert.match(
    await readFile(join(directory, "credentials.json"), "utf8"),
    /old-secret/
  )

  await store.saveProvider("fake", { token: "new-secret" })
  assert.match(
    await readFile(join(directory, "credentials.json"), "utf8"),
    /new-secret/
  )
  assert.doesNotMatch(
    await readFile(join(directory, "credentials.json"), "utf8"),
    /old-secret/
  )
})

test("missing and malformed local speech files are safe and do not include file contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speech-"))
  const store = new LocalSpeechStore(directory)
  assert.deepEqual(await store.readConfig(), {})
  await writeFile(
    join(directory, "config.json"),
    '{"token":"malformed-secret",',
    "utf8"
  )
  await assert.rejects(
    () => store.readConfig(),
    (error: unknown) => {
      assert.equal(error instanceof Error, true)
      assert.doesNotMatch(String(error), /malformed-secret/)
      return true
    }
  )
})

test("environment provider and complete environment credentials bypass corrupt local files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speech-"))
  await writeFile(
    join(directory, "config.json"),
    '{"broken":"config-secret",',
    "utf8"
  )
  await writeFile(
    join(directory, "credentials.json"),
    '{"broken":"credential-secret",',
    "utf8"
  )
  const calls = { validate: 0, diagnose: 0 }
  const registry = new MutableSpeechProviderRegistry()
  registry.register(fakeProvider(calls))
  const output: string[] = []

  await runSpeechCommand(["doctor", "--json"], {
    registry,
    store: new LocalSpeechStore(directory),
    environment: {
      FREE4CHAT_STT_PROVIDER: "fake",
      FREE4CHAT_FAKE_TOKEN: "secret-sentinel",
    },
    stdout: (text) => output.push(text),
  })

  assert.equal(calls.diagnose, 1)
  assert.match(output[0] ?? "", /"ready": true/)
  assert.doesNotMatch(
    output[0] ?? "",
    /config-secret|credential-secret|secret-sentinel/
  )
})

test("complete environment credentials bypass corrupt credentials for a locally selected provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speech-"))
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ speech: { stt: { provider: "fake" } } }),
    "utf8"
  )
  await writeFile(join(directory, "credentials.json"), "{broken:", "utf8")
  const calls = { validate: 0, diagnose: 0 }
  const registry = new MutableSpeechProviderRegistry()
  registry.register(fakeProvider(calls))
  const output: string[] = []

  await runSpeechCommand(["doctor", "--json"], {
    registry,
    store: new LocalSpeechStore(directory),
    environment: { FREE4CHAT_FAKE_TOKEN: "secret-sentinel" },
    stdout: (text) => output.push(text),
  })

  assert.equal(calls.diagnose, 1)
  assert.match(output[0] ?? "", /"ready": true/)
})

test("required local storage corruption is an explicit secret-free command error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speech-"))
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ speech: { stt: { provider: "fake" } } }),
    "utf8"
  )
  await writeFile(
    join(directory, "credentials.json"),
    '{"token":"credential-secret",',
    "utf8"
  )
  const registry = new MutableSpeechProviderRegistry()
  registry.register(fakeProvider({ validate: 0, diagnose: 0 }))

  await assert.rejects(
    () =>
      runSpeechCommand(["status", "--json"], {
        registry,
        store: new LocalSpeechStore(directory),
      }),
    (error: unknown) => {
      assert.match(String(error), /speech storage is unavailable or malformed/)
      assert.doesNotMatch(String(error), /credential-secret/)
      return true
    }
  )
})

test("speech setup validates before persistence and doctor runs the bounded diagnostic", async () => {
  const calls = { validate: 0, diagnose: 0 }
  const registry = new MutableSpeechProviderRegistry()
  registry.register(fakeProvider(calls))
  const store = new MemoryStore()
  const output: string[] = []
  let reads = 0
  await runSpeechCommand(["setup", "fake"], {
    registry,
    store,
    input: {
      read: async () => {
        reads += 1
        return "secret-sentinel"
      },
    },
    stdout: (text) => output.push(text),
  })
  assert.equal(reads, 1)
  assert.equal(calls.validate, 1)
  assert.deepEqual(store.credentials.providers?.fake, {
    token: "secret-sentinel",
  })
  assert.doesNotMatch(output.join("\n"), /secret-sentinel/)

  await runSpeechCommand(["speech-does-not-exist"], {
    registry,
    store,
    input: {
      read: async () => {
        throw new Error("must not collect")
      },
    },
  }).catch(() => undefined)
  await runSpeechCommand(["doctor", "--json"], {
    registry,
    store,
    stdout: (text) => output.push(text),
  })
  assert.equal(calls.diagnose, 1)
  assert.match(output.at(-1) ?? "", /"ready": true/)
})

test("speech status is local-only, unknown providers fail before secret collection, and setup errors redact secrets", async () => {
  const calls = { validate: 0, diagnose: 0 }
  const registry = new MutableSpeechProviderRegistry()
  registry.register(fakeProvider(calls, "different-secret"))
  const store = new MemoryStore()
  const output: string[] = []
  await runSpeechCommand(["status", "--json"], {
    registry,
    store,
    stdout: (text) => output.push(text),
  })
  assert.match(output[0] ?? "", /"provider": null/)
  assert.equal(calls.diagnose, 0)
  await runSpeechCommand(["doctor", "--json"], {
    registry,
    store,
    stdout: (text) => output.push(text),
  })
  assert.match(output[1] ?? "", /"ready": false/)

  let collected = false
  store.credentials = { providers: { fake: { token: "old-secret" } } }
  await assert.rejects(
    () =>
      runSpeechCommand(["setup", "doubao"], {
        registry,
        store,
        input: {
          read: async () => {
            collected = true
            return "secret-sentinel"
          },
        },
      }),
    /not available/
  )
  assert.equal(collected, false)

  await assert.rejects(
    () =>
      runSpeechCommand(["setup", "fake"], {
        registry,
        store,
        input: { read: async () => "secret-sentinel" },
      }),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /secret-sentinel/)
      return true
    }
  )
  assert.deepEqual(store.credentials.providers?.fake, { token: "old-secret" })
})

test("explicit provider environment values take precedence over stored credentials", async () => {
  const calls = { validate: 0, diagnose: 0 }
  const registry = new MutableSpeechProviderRegistry()
  registry.register(fakeProvider(calls))
  const store = new MemoryStore()
  store.config = { speech: { stt: { provider: "fake" } } }
  store.credentials = { providers: { fake: { token: "old-secret" } } }
  const output: string[] = []
  await runSpeechCommand(["doctor", "--json"], {
    registry,
    store,
    environment: { FREE4CHAT_FAKE_TOKEN: "secret-sentinel" },
    stdout: (text) => output.push(text),
  })
  assert.equal(calls.diagnose, 1)
  assert.match(output[0] ?? "", /"ready": true/)
  assert.doesNotMatch(output[0] ?? "", /old-secret|secret-sentinel/)
})

test("credential persistence precedes activation and a config write failure preserves the old provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "free4chat-speech-"))
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ speech: { stt: { provider: "old" } } }),
    "utf8"
  )
  await writeFile(
    join(directory, "credentials.json"),
    JSON.stringify({ providers: { old: { token: "old-secret" } } }),
    "utf8"
  )
  const writes: string[] = []
  const store = new LocalSpeechStore(directory, {
    writeJson: async (targetDirectory, fileName, value) => {
      writes.push(fileName)
      if (fileName === "credentials.json") {
        await writeFile(
          join(targetDirectory, fileName),
          `${JSON.stringify(value)}\n`,
          "utf8"
        )
        return
      }
      throw new Error("injected config write failure")
    },
  })

  await assert.rejects(() => store.saveProvider("new", { token: "new-secret" }))
  assert.deepEqual(writes, ["credentials.json", "config.json"])
  assert.match(
    await readFile(join(directory, "config.json"), "utf8"),
    /"provider":"old"/
  )
  assert.match(
    await readFile(join(directory, "credentials.json"), "utf8"),
    /new-secret/
  )
})
