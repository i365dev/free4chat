import { writeFile } from "node:fs/promises"

import { redactSecrets, safeErrorMessage } from "./redaction.js"
import { TerminalSetupInput, type SetupInput } from "./secretInput.js"
import { productionSpeechRegistry } from "./registry.js"
import type { SpeechProviderRegistry } from "./types.js"
import {
  hasRequiredValues,
  resolveSpeechProviderState,
} from "./providerState.js"
import { resolveConfiguredTtsProvider } from "../voice/ttsProvider.js"
import {
  pcmSilenceWavHeader,
  DOUBAO_TTS_SAMPLE_RATE_HZ,
} from "./providers/doubao/ttsProtocol.js"
import { LocalSpeechStore, type SpeechStore } from "./storage.js"

export interface SpeechCliDependencies {
  registry?: SpeechProviderRegistry
  store?: SpeechStore
  input?: SetupInput
  environment?: NodeJS.ProcessEnv
  stdout?: (text: string) => void
}

interface SpeechStatus {
  stt: {
    provider: string | null
    configured: boolean
    supported: boolean
    ready?: boolean
    message?: string
  }
}

const SPEECH_HOOK_TIMEOUT_MS = 10_000

async function boundedHook<T>(
  hook: () => Promise<T>,
  name: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} timed out`))
    }, SPEECH_HOOK_TIMEOUT_MS)
    void hook().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function outputJsonOrText(
  report: SpeechStatus,
  json: boolean,
  stdout: (text: string) => void
): void {
  if (json) {
    stdout(JSON.stringify(report, null, 2))
    return
  }
  const { stt } = report
  stdout(
    `STT: ${stt.provider ?? "not configured"} | ${
      stt.ready ? "ready" : stt.configured ? "configured" : "unavailable"
    }${stt.message ? ` | ${stt.message}` : ""}`
  )
}

export async function runSpeechCommand(
  args: string[],
  dependencies: SpeechCliDependencies = {}
): Promise<void> {
  const [subcommand, ...rest] = args
  const registry = dependencies.registry ?? productionSpeechRegistry()
  const store = dependencies.store ?? new LocalSpeechStore()
  const environment = dependencies.environment ?? process.env
  const stdout = dependencies.stdout ?? console.log

  if (subcommand === "status" || subcommand === "doctor") {
    const json = rest.length === 1 && rest[0] === "--json"
    if (rest.length > 0 && !json)
      throw new Error(`speech ${subcommand} accepts only [--json]`)
    const state = await resolveSpeechProviderState(registry, store, environment)
    const report: SpeechStatus = {
      stt: {
        provider: state.providerId ?? null,
        configured: Boolean(
          state.provider && hasRequiredValues(state.provider, state.values)
        ),
        supported: Boolean(
          state.provider?.capabilities.includes("stt") &&
          state.provider.createSttProvider
        ),
        ...(subcommand === "doctor" ? { ready: false } : {}),
      },
    }
    if (subcommand === "doctor" && report.stt.configured && state.provider) {
      try {
        const diagnostic = await boundedHook(
          () => state.provider!.diagnose(state.values),
          "speech provider diagnosis"
        )
        report.stt.ready = diagnostic.ready
        if (!diagnostic.ready && diagnostic.message)
          report.stt.message = redactSecrets(
            diagnostic.message,
            Object.values(state.values)
          )
      } catch (error) {
        throw new Error(
          redactSecrets(safeErrorMessage(error, Object.values(state.values)))
        )
      }
    }
    outputJsonOrText(report, json, stdout)
    return
  }

  if (subcommand === "setup") {
    const useStdin = rest.includes("--stdin")
    const positional = rest.filter((a) => !a.startsWith("--"))
    if (positional.length !== 1 || positional[0] === "")
      throw new Error(
        "usage: free4chat-agent speech setup <provider> [--stdin]"
      )
    const providerId = positional[0]
    const provider = registry.get(providerId)
    if (!provider)
      throw new Error(
        `speech provider ${providerId} is not available in this build`
      )
    // --stdin (#105): a calling Agent pipes the secret non-interactively so
    // it can complete setup itself; interactive TTY entry remains the
    // default for humans. Only the first secret field is read from stdin;
    // remaining optional fields fall back to their prompts.
    let stdinSecret: string | undefined
    if (useStdin) {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      stdinSecret = Buffer.concat(chunks).toString("utf8").trim()
      if (!stdinSecret) throw new Error("empty --stdin secret")
    }
    const input = dependencies.input ?? new TerminalSetupInput()
    const values: Record<string, string> = {}
    for (const field of provider.setupFields) {
      let value: string
      if (stdinSecret !== undefined && field.secret && field.key === "apiKey") {
        value = stdinSecret
      } else {
        value = (await input.read(field)).trim()
      }
      if (field.required && !value)
        throw new Error(`${field.label} is required`)
      values[field.key] = value
    }
    const secrets = provider.setupFields
      .filter((field) => field.secret)
      .map((field) => values[field.key])
    let validation
    try {
      validation = await boundedHook(
        () => provider.validate(values),
        "speech provider validation"
      )
    } catch (error) {
      throw new Error(redactSecrets(safeErrorMessage(error, secrets), secrets))
    }
    if (!validation.valid)
      throw new Error(
        redactSecrets(
          validation.message ?? "speech provider validation failed",
          secrets
        )
      )
    // Selection slots follow capability (#83 review): each capability the
    // provider supports is activated in its own slot, so a dual-capability
    // provider like doubao powers both while a TTS-only provider can never
    // displace an existing STT selection.
    const slots: ("stt" | "tts")[] = []
    if (provider.capabilities.includes("stt")) slots.push("stt")
    if (provider.capabilities.includes("tts")) slots.push("tts")
    if (slots.length === 0)
      throw new Error(
        `speech provider ${provider.id} has no configurable speech capability`
      )
    await store.saveProvider(provider.id, values, { slots })
    stdout(`Speech provider ${provider.id} configured.`)
    return
  }

  if (subcommand === "speak-tts") {
    const flags = parseSpeakTtsFlags(rest)
    // Same resolution as the resident Runtime's voice wiring: config tts
    // slot or FREE4CHAT_TTS_PROVIDER override over the shared credential
    // store. This is the local real-audio entry point; room-audible SFU
    // playback is a separate, not-yet-wired capability (#83).
    const resolved = await resolveConfiguredTtsProvider({
      registry,
      store,
      environment,
    })
    if (!resolved.tts)
      throw new Error(
        "no text-to-speech provider is configured locally; run " +
          "`free4chat-agent speech setup doubao` (or set " +
          "FREE4CHAT_TTS_PROVIDER) first"
      )
    const session = await resolved.tts.createSession()
    const parts: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of session.synthesize(flags.text)) {
        const piece = Buffer.from(chunk.data)
        bytes += piece.byteLength
        parts.push(piece)
      }
    } catch (error) {
      throw new Error(
        redactSecrets(safeErrorMessage(error), [
          environment.DOUBAO_API_KEY ?? "",
        ])
      )
    }
    if (bytes === 0) throw new Error("the provider returned no audio")
    const payload =
      flags.wav && bytes > 0
        ? Buffer.concat([pcmSilenceWavHeader(bytes), ...parts])
        : Buffer.concat(parts)
    await writeFile(flags.out, payload, { mode: 0o600 })
    stdout(
      `Wrote ${bytes} PCM bytes (${DOUBAO_TTS_SAMPLE_RATE_HZ} Hz mono s16le` +
        `${flags.wav ? ", wav-wrapped" : ""}) to ${flags.out}`
    )
    return
  }

  throw new Error(
    "usage: free4chat-agent speech <status|doctor|setup|speak-tts>"
  )
}

interface SpeakTtsFlags {
  text: string
  out: string
  wav: boolean
}

function parseSpeakTtsFlags(rest: string[]): SpeakTtsFlags {
  let text: string | undefined
  let out: string | undefined
  let wav = false
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (flag === "--text") {
      text = rest[i + 1]
      i += 1
    } else if (flag === "--out") {
      out = rest[i + 1]
      i += 1
    } else if (flag === "--wav") {
      wav = true
    } else {
      throw new Error(`unknown speak-tts flag: ${flag}`)
    }
  }
  if (!text || !text.trim())
    throw new Error(
      "usage: free4chat-agent speech speak-tts --text <text> [--out file] [--wav]"
    )
  return {
    text,
    out: out ?? `free4chat-tts-probe.${wav ? "wav" : "pcm"}`,
    wav,
  }
}
