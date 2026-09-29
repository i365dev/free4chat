/**
 * The deliberately small Room projection and request contract for one local
 * Runtime capability. This is semantic metadata only: endpoint URLs,
 * credentials, adapter settings, and device protocols are never accepted.
 */

export const RUNTIME_CAPABILITY_MAX_DESCRIPTOR_BYTES = 1024
export const RUNTIME_CAPABILITY_MAX_ARGS_BYTES = 8192
export const RUNTIME_CAPABILITY_MAX_RESULT_BYTES = 16 * 1024
export const RUNTIME_CAPABILITY_MAX_ACTIONS = 4
export const RUNTIME_CAPABILITY_MAX_IN_FLIGHT = 4
export const RUNTIME_CAPABILITY_TIMEOUT_MS = 10_000
export const RUNTIME_CAPABILITY_MAX_ROOM_HOSTS = 8

export interface RuntimeCapabilityAction {
  name: string
  title: string
  /** A bounded JSON Schema subset: object properties with primitive types. */
  input: {
    type: "object"
    properties: Record<string, "string" | "number" | "boolean">
    required?: string[]
  }
}

export interface RuntimeCapabilityProjection {
  capabilityId: string
  title: string
  version: string
  observe: boolean
  actions: RuntimeCapabilityAction[]
}

export type RuntimeCapabilityOperation = "observe" | "invoke"

export interface RuntimeCapabilityResult {
  type: "runtime-capability-result"
  requestId: string
  ok: boolean
  result?: Record<string, unknown>
  error?:
    | "unavailable"
    | "timeout"
    | "invalid_request"
    | "controller_error"
    | "unauthorized"
    | "duplicate_request"
    | "busy"
}

const encoder = new TextEncoder()

function bytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/https?:\/\//i.test(value)
  )
}

const sensitiveFieldName =
  /(?:endpoint|url|credential|password|secret|token|adapter|protocol|hostname|authorization|cookie|method|path)/i

function safeCapabilityValue(value: unknown, depth = 0): boolean {
  if (depth > 4) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string")
    return value.length <= 4096 && !/https?:\/\//i.test(value)
  if (Array.isArray(value))
    return (
      value.length <= 32 &&
      value.every((item) => safeCapabilityValue(item, depth + 1))
    )
  if (!value || typeof value !== "object") return false
  const entries = Object.entries(value as Record<string, unknown>)
  return (
    entries.length <= 32 &&
    entries.every(
      ([key, item]) =>
        key.length <= 64 &&
        !sensitiveFieldName.test(key) &&
        safeCapabilityValue(item, depth + 1)
    )
  )
}

export function isRuntimeCapabilityId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value)
}

export function isRuntimeCapabilityActionName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value)
}

export function validateRuntimeCapabilityProjection(
  value: unknown
): RuntimeCapabilityProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    !isRuntimeCapabilityId(candidate.capabilityId) ||
    !boundedText(candidate.title, 64) ||
    !boundedText(candidate.version, 32) ||
    typeof candidate.observe !== "boolean" ||
    !Array.isArray(candidate.actions) ||
    candidate.actions.length > RUNTIME_CAPABILITY_MAX_ACTIONS
  )
    return null

  const names = new Set<string>()
  const actions: RuntimeCapabilityAction[] = []
  for (const raw of candidate.actions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const action = raw as Record<string, unknown>
    const input = action.input
    if (
      !isRuntimeCapabilityActionName(action.name) ||
      sensitiveFieldName.test(action.name) ||
      names.has(action.name) ||
      !boundedText(action.title, 64) ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      return null
    const schema = input as Record<string, unknown>
    const properties = schema.properties
    if (
      schema.type !== "object" ||
      !properties ||
      typeof properties !== "object" ||
      Array.isArray(properties) ||
      Object.keys(properties).length > 16 ||
      (schema.required !== undefined && !Array.isArray(schema.required))
    )
      return null
    const cleanProperties: Record<string, "string" | "number" | "boolean"> = {}
    for (const [key, type] of Object.entries(properties)) {
      if (
        !/^[a-z][a-zA-Z0-9_]{0,31}$/.test(key) ||
        sensitiveFieldName.test(key)
      )
        return null
      if (type !== "string" && type !== "number" && type !== "boolean")
        return null
      cleanProperties[key] = type
    }
    let required: string[] | undefined
    if (schema.required !== undefined) {
      const rawRequired = schema.required
      if (!Array.isArray(rawRequired)) return null
      if (
        rawRequired.length > Object.keys(cleanProperties).length ||
        !rawRequired.every(
          (key) =>
            typeof key === "string" && Object.hasOwn(cleanProperties, key)
        ) ||
        new Set(rawRequired).size !== rawRequired.length
      )
        return null
      required = rawRequired as string[]
    }
    names.add(action.name)
    actions.push({
      name: action.name,
      title: action.title,
      input: {
        type: "object",
        properties: cleanProperties,
        ...(required ? { required } : {}),
      },
    })
  }
  const projection = {
    capabilityId: candidate.capabilityId,
    title: candidate.title,
    version: candidate.version,
    observe: candidate.observe,
    actions,
  }
  if (bytes(projection) > RUNTIME_CAPABILITY_MAX_DESCRIPTOR_BYTES) return null
  return projection
}

export function isBoundedRuntimeCapabilityArgs(
  value: unknown
): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    safeCapabilityValue(value) &&
    bytes(value) <= RUNTIME_CAPABILITY_MAX_ARGS_BYTES
  )
}

export function isBoundedRuntimeCapabilityResult(
  value: unknown
): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    safeCapabilityValue(value) &&
    bytes(value) <= RUNTIME_CAPABILITY_MAX_RESULT_BYTES
  )
}
