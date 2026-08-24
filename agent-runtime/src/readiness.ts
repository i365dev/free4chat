import { resolveMediaEngineName } from "./media/engine.js"
import {
  probePionBinary,
  type EnsurePionBinaryOptions,
} from "./media/pionProvision.js"
import {
  hasRequiredValues,
  resolveSpeechProviderState,
} from "./speech/providerState.js"
import { productionSpeechRegistry } from "./speech/registry.js"
import { LocalSpeechStore } from "./speech/storage.js"

export interface RuntimeReadiness {
  ready: boolean
  version: string
  nodeMajor: number
  nodeCompatible: boolean
}

export interface MediaReadiness {
  engine: "pion" | "werift"
  supported: boolean
  ready: boolean
  binPath?: string
  reason?: string
}

export interface SpeechSttReadiness {
  provider: string | null
  configured: boolean
  ready: boolean
  needsUserInput?: "api_key"
  message?: string
}

export interface RoomReadiness {
  joined: boolean
  roomId?: string
  instanceId?: string
  participantId?: string
  reason?: string
}

export interface HarnessReadiness {
  id: string
  ready: boolean
  note?: string
}

export interface ReadinessReport {
  runtime: RuntimeReadiness
  media: MediaReadiness
  speech: { stt: SpeechSttReadiness }
  room?: RoomReadiness
  harness?: HarnessReadiness
}

export interface ReadinessRoomOptions {
  /** When set, readiness queries the resident daemon for an actual live
   * instance in this room instead of only reporting local prerequisites. */
  roomId?: string
  /** Optional requested Harness launcher id to include readiness for. */
  agentId?: string
}

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10)
}

export function runtimeReadiness(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeReadiness {
  const major = nodeMajor()
  return {
    ready: major >= 22,
    version: process.versions.node,
    nodeMajor: major,
    nodeCompatible: major >= 22,
    ...(environment.FREE4CHAT_MEDIA_ENGINE
      ? { mediaEngineEnv: environment.FREE4CHAT_MEDIA_ENGINE }
      : {}),
  } as RuntimeReadiness
}

/** Cheap, non-networking media readiness: override/cache presence only.
 * Actual provisioning happens lazily when realtime media is first used. */
export async function mediaReadiness(
  environment: {
    FREE4CHAT_MEDIA_ENGINE?: string
    FREE4CHAT_PION_BIN?: string
    FREE4CHAT_AGENT_DIR?: string
  } = process.env
): Promise<MediaReadiness> {
  const engine = resolveMediaEngineName(environment)
  if (engine === "werift")
    return {
      engine,
      supported: true,
      ready: true,
      reason: "werift_fallback_engine",
    }
  const options: EnsurePionBinaryOptions = {
    binOverride: environment.FREE4CHAT_PION_BIN,
  }
  if (environment.FREE4CHAT_AGENT_DIR)
    options.cacheRoot = `${environment.FREE4CHAT_AGENT_DIR}/media`
  const probe = await probePionBinary(options)
  return {
    engine,
    supported: true,
    ready: probe.ready,
    ...(probe.binPath ? { binPath: probe.binPath } : {}),
    ...(probe.reason ? { reason: probe.reason } : {}),
  }
}

export interface SpeechSttDeps {
  registry?: ReturnType<typeof productionSpeechRegistry>
  store?: { readConfig?: unknown } & Record<string, any>
}

export interface SpeechReadinessDeps {
  registry?: ReturnType<typeof productionSpeechRegistry>
  store?: InstanceType<typeof LocalSpeechStore>
}

export async function speechSttReadiness(
  environment: NodeJS.ProcessEnv = process.env,
  deps?: SpeechReadinessDeps
): Promise<SpeechSttReadiness> {
  try {
    const store = deps?.store ?? new LocalSpeechStore()
    const registry = deps?.registry ?? productionSpeechRegistry()
    const state = await resolveSpeechProviderState(registry, store, environment)
    const provider = state.provider
    const providerId = state.providerId ?? null
    if (!provider)
      return {
        provider: providerId,
        configured: false,
        ready: false,
        // Meeting Notes defaults to Doubao STT; an unconfigured environment's
        // single actionable prerequisite is the user-supplied API key (#90).
        needsUserInput: "api_key" as const,
        message: "no speech provider selected/configured",
      }
    if (!hasRequiredValues(provider, state.values))
      return {
        provider: providerId,
        configured: false,
        ready: false,
        needsUserInput: "api_key" as const,
        message: "missing required credential values",
      }
    if (provider.validate) {
      const verdict = await provider.validate(state.values)
      if (verdict.valid === false)
        return {
          provider: providerId,
          configured: true,
          ready: false,
          message: verdict.message ?? "provider validation failed",
        }
    }
    return { provider: providerId, configured: true, ready: true }
  } catch (error) {
    return {
      provider: null,
      configured: false,
      ready: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export type ReadinessDeps = SpeechReadinessDeps

/** Pure projection of daemon instance status into room readiness. */
export function roomReadinessFromStatus(
  roomId: string | undefined,
  instances:
    | Array<{
        instanceId: string
        roomId?: string
        participantId?: string
      }>
    | null
    | undefined
): RoomReadiness | undefined {
  if (!roomId) return undefined
  const inst = (instances ?? []).find((i) => i.roomId === roomId)
  if (inst)
    return {
      joined: true,
      roomId,
      instanceId: inst.instanceId,
      participantId: inst.participantId,
    }
  return { joined: false, roomId, reason: "not_joined" }
}

export async function buildReadinessReport(
  environment: NodeJS.ProcessEnv = process.env,
  deps?: ReadinessDeps
): Promise<ReadinessReport> {
  const [media, stt] = await Promise.all([
    mediaReadiness(environment),
    speechSttReadiness(environment, deps),
  ])
  const runtime = runtimeReadiness(environment)
  return { runtime, media, speech: { stt } }
}
