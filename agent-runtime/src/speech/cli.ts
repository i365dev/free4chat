import { redactSecrets, safeErrorMessage } from "./redaction.js"
import { TerminalSetupInput, type SetupInput } from "./secretInput.js"
import { productionSpeechRegistry } from "./registry.js"
import type { SpeechProviderRegistry } from "./types.js"
import {
  hasRequiredValues,
  resolveSpeechProviderState,
} from "./providerState.js"
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
    if (rest.length !== 1 || rest[0]?.startsWith("--"))
      throw new Error("usage: free4chat-agent speech setup <provider>")
    const providerId = rest[0]
    const provider = registry.get(providerId)
    if (!provider)
      throw new Error(
        `speech provider ${providerId} is not available in this build`
      )
    const input = dependencies.input ?? new TerminalSetupInput()
    const values: Record<string, string> = {}
    for (const field of provider.setupFields) {
      const value = (await input.read(field)).trim()
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
    await store.saveProvider(provider.id, values)
    stdout(`Speech provider ${provider.id} configured.`)
    return
  }

  throw new Error("usage: free4chat-agent speech <status|doctor|setup>")
}
