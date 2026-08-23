import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { runtimeDirectory } from "../core/paths.js"

export interface SpeechConfig {
  speech?: { stt?: { provider?: string } }
}

export interface SpeechCredentials {
  providers?: Record<string, Record<string, string>>
}

export interface SpeechStore {
  readConfig(): Promise<SpeechConfig>
  readCredentials(): Promise<SpeechCredentials>
  saveProvider(
    providerId: string,
    values: Record<string, string>
  ): Promise<void>
}

export type SpeechJsonWriter = (
  directory: string,
  fileName: string,
  value: unknown
) => Promise<void>

export interface LocalSpeechStoreOptions {
  /** Injectable for failure-order tests; production uses atomic rename. */
  writeJson?: SpeechJsonWriter
}

function storageError(fileName: string): Error {
  return new Error(`free4chat-agent ${fileName} is malformed`)
}

async function readJson<T>(path: string, fileName: string): Promise<T> {
  try {
    const text = await readFile(path, "utf8")
    return JSON.parse(text) as T
  } catch (error) {
    if (error instanceof SyntaxError) throw storageError(fileName)
    const code = error as NodeJS.ErrnoException
    if (code.code === "ENOENT") return {} as T
    throw new Error(`unable to read free4chat-agent ${fileName}`)
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  } catch {
    throw new Error("unable to prepare free4chat-agent storage")
  }
}

async function atomicWriteJson(
  directory: string,
  fileName: string,
  value: unknown
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, join(directory, fileName))
    await chmod(join(directory, fileName), 0o600)
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new Error(`unable to write free4chat-agent ${fileName}`)
  }
}

export class LocalSpeechStore implements SpeechStore {
  private readonly writeJson: SpeechJsonWriter

  constructor(
    private readonly directory = runtimeDirectory(),
    options: LocalSpeechStoreOptions = {}
  ) {
    this.writeJson = options.writeJson ?? atomicWriteJson
  }

  async readConfig(): Promise<SpeechConfig> {
    await ensureDirectory(this.directory)
    return readJson<SpeechConfig>(
      join(this.directory, "config.json"),
      "config.json"
    )
  }

  async readCredentials(): Promise<SpeechCredentials> {
    await ensureDirectory(this.directory)
    return readJson<SpeechCredentials>(
      join(this.directory, "credentials.json"),
      "credentials.json"
    )
  }

  async saveProvider(
    providerId: string,
    values: Record<string, string>
  ): Promise<void> {
    const config = await this.readConfig()
    const credentials = await this.readCredentials()
    const providers = { ...(credentials.providers ?? {}) }
    providers[providerId] = { ...values }
    // Credentials are supporting data; the config provider selection is the
    // activation pointer and must be committed last.
    await this.writeJson(this.directory, "credentials.json", { providers })
    await this.writeJson(this.directory, "config.json", {
      ...config,
      speech: {
        ...(config.speech ?? {}),
        stt: { ...(config.speech?.stt ?? {}), provider: providerId },
      },
    })
  }
}

export function selectedProviderId(
  config: SpeechConfig,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const configured = config.speech?.stt?.provider
  return (
    environment.FREE4CHAT_STT_PROVIDER ||
    (typeof configured === "string" ? configured : undefined)
  )
}

export function resolvedProviderValues(
  provider: {
    setupFields: readonly { key: string; environmentVariable?: string }[]
  },
  stored: Record<string, string> | undefined,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(stored ?? {}))
    if (typeof value === "string") values[key] = value
  for (const field of provider.setupFields) {
    if (field.environmentVariable && environment[field.environmentVariable])
      values[field.key] = environment[field.environmentVariable] as string
  }
  return values
}
