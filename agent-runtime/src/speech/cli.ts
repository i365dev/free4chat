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
    // Selection slot follows capability (#83 review): an stt-capable
    // provider keeps activating through the historical speech.stt slot,
    // while a TTS-only provider activates through speech.tts so configuring
    // it can never displace an existing STT selection.
    const slot = provider.capabilities.includes("stt")
      ? "stt"
      : provider.capabilities.includes("tts")
        ? "tts"
        : undefined
    if (!slot)
      throw new Error(
        `speech provider ${provider.id} has no configurable speech capability`
      )
    await store.saveProvider(provider.id, values, { slot })
    stdout(`Speech provider ${provider.id} configured.`)
    return
  }

  throw new Error("usage: free4chat-agent speech <status|doctor|setup>")
}
