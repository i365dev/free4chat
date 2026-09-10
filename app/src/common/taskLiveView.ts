import type { MutableRefObject } from "react"

export const MAX_TASK_LIVE_VIEW_BYTES = 32 * 1024
export const MAX_TASK_LIVE_VIEW_COMPONENTS = 64
export const MAX_TASK_LIVE_VIEW_DEPTH = 8
export const MAX_TASK_LIVE_VIEW_DATA_KEYS = 32

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const DATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const PATH_PATTERN = DATA_KEY_PATTERN
const MAX_TEXT_LENGTH = 400
const MAX_LABEL_LENGTH = 80

export type TaskLiveViewScalar = string | number | boolean

export type TaskLiveViewAction =
  | { type: "increment"; path: string; amount: number }
  | { type: "set"; path: string; value: TaskLiveViewScalar }

export type TaskLiveViewComponent =
  | { type: "Text"; text: string }
  | { type: "Value"; path: string }
  | { type: "Button"; label: string; action: TaskLiveViewAction }
  | { type: "Input"; path: string; placeholder?: string }
  | { type: "Row"; children: TaskLiveViewComponent[] }
  | { type: "Column"; children: TaskLiveViewComponent[] }
  | { type: "Card"; children: TaskLiveViewComponent[] }

export interface TaskLiveViewSnapshot {
  taskRequestId: string
  surfaceId: string
  authorityAgentId: string
  revision: number
  root: TaskLiveViewComponent
  data: Record<string, TaskLiveViewScalar>
}

export interface TaskLiveViewLocalState {
  surfaceId: string
  revision: number
  data: Record<string, TaskLiveViewScalar>
}

export type TaskLiveViewValidation =
  | { ok: true; snapshot: TaskLiveViewSnapshot }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[<>]|(?:javascript:|https?:\/\/|data:)/i.test(value)
  )
}

function isScalar(value: unknown): value is TaskLiveViewScalar {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && isSafeText(value, MAX_TEXT_LENGTH))
  )
}

function validateAction(value: unknown): value is TaskLiveViewAction {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "increment")
    return (
      hasOnlyKeys(value, ["type", "path", "amount"]) &&
      typeof value.path === "string" &&
      PATH_PATTERN.test(value.path) &&
      typeof value.amount === "number" &&
      Number.isSafeInteger(value.amount) &&
      value.amount !== 0 &&
      Math.abs(value.amount) <= 1000
    )
  return (
    value.type === "set" &&
    hasOnlyKeys(value, ["type", "path", "value"]) &&
    typeof value.path === "string" &&
    PATH_PATTERN.test(value.path) &&
    isScalar(value.value)
  )
}

function validateComponent(
  value: unknown,
  depth: number,
  count: { value: number },
  data: Record<string, TaskLiveViewScalar>
): value is TaskLiveViewComponent {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (depth > MAX_TASK_LIVE_VIEW_DEPTH) return false
  count.value += 1
  if (count.value > MAX_TASK_LIVE_VIEW_COMPONENTS) return false

  switch (value.type) {
    case "Text":
      return (
        hasOnlyKeys(value, ["type", "text"]) &&
        isSafeText(value.text, MAX_TEXT_LENGTH)
      )
    case "Value":
      return (
        hasOnlyKeys(value, ["type", "path"]) &&
        typeof value.path === "string" &&
        PATH_PATTERN.test(value.path)
      )
    case "Button":
      return (
        hasOnlyKeys(value, ["type", "label", "action"]) &&
        isSafeText(value.label, MAX_LABEL_LENGTH) &&
        validateAction(value.action)
      )
    case "Input":
      return (
        hasOnlyKeys(value, ["type", "path", "placeholder"]) &&
        typeof value.path === "string" &&
        PATH_PATTERN.test(value.path) &&
        typeof data[value.path] === "string" &&
        (value.placeholder === undefined ||
          isSafeText(value.placeholder, MAX_LABEL_LENGTH))
      )
    case "Row":
    case "Column":
    case "Card":
      return (
        hasOnlyKeys(value, ["type", "children"]) &&
        Array.isArray(value.children) &&
        value.children.length > 0 &&
        value.children.length <= MAX_TASK_LIVE_VIEW_COMPONENTS &&
        value.children.every((child) =>
          validateComponent(child, depth + 1, count, data)
        )
      )
    default:
      return false
  }
}

export function validateTaskLiveViewSnapshot(
  raw: unknown
): TaskLiveViewValidation {
  if (!isRecord(raw)) return { ok: false, error: "invalid_live_view" }
  let serialized: string
  try {
    serialized = JSON.stringify(raw)
  } catch {
    return { ok: false, error: "invalid_live_view" }
  }
  if (
    new TextEncoder().encode(serialized).byteLength > MAX_TASK_LIVE_VIEW_BYTES
  )
    return { ok: false, error: "live_view_too_large" }
  if (
    !hasOnlyKeys(raw, [
      "taskRequestId",
      "surfaceId",
      "authorityAgentId",
      "revision",
      "root",
      "data",
    ]) ||
    typeof raw.taskRequestId !== "string" ||
    !ID_PATTERN.test(raw.taskRequestId) ||
    typeof raw.surfaceId !== "string" ||
    !ID_PATTERN.test(raw.surfaceId) ||
    typeof raw.authorityAgentId !== "string" ||
    !ID_PATTERN.test(raw.authorityAgentId) ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    !isRecord(raw.data) ||
    Object.keys(raw.data).length > MAX_TASK_LIVE_VIEW_DATA_KEYS
  )
    return { ok: false, error: "invalid_live_view" }

  for (const [key, value] of Object.entries(raw.data))
    if (!DATA_KEY_PATTERN.test(key) || !isScalar(value))
      return { ok: false, error: "invalid_live_view_data" }

  const count = { value: 0 }
  const data = raw.data as Record<string, TaskLiveViewScalar>
  if (!validateComponent(raw.root, 1, count, data))
    return { ok: false, error: "invalid_live_view_component" }

  return {
    ok: true,
    snapshot: {
      taskRequestId: raw.taskRequestId,
      surfaceId: raw.surfaceId,
      authorityAgentId: raw.authorityAgentId,
      revision: raw.revision,
      root: raw.root,
      data: { ...(raw.data as Record<string, TaskLiveViewScalar>) },
    },
  }
}

function sameScalarType(left: TaskLiveViewScalar, right: TaskLiveViewScalar) {
  return typeof left === typeof right
}

export function initialTaskLiveViewState(
  snapshot: TaskLiveViewSnapshot
): TaskLiveViewLocalState {
  return {
    surfaceId: snapshot.surfaceId,
    revision: snapshot.revision,
    data: { ...snapshot.data },
  }
}

export function applyTaskLiveViewAction(
  data: Record<string, TaskLiveViewScalar>,
  action: TaskLiveViewAction
): Record<string, TaskLiveViewScalar> {
  const current = data[action.path]
  if (action.type === "increment") {
    if (typeof current !== "number") return data
    return { ...data, [action.path]: current + action.amount }
  }
  return { ...data, [action.path]: action.value }
}

export function reconcileTaskLiveViewState(
  previous: TaskLiveViewLocalState | undefined,
  next: TaskLiveViewSnapshot
): TaskLiveViewLocalState {
  if (
    !previous ||
    previous.surfaceId !== next.surfaceId ||
    next.revision < previous.revision
  )
    return initialTaskLiveViewState(next)

  const data = { ...next.data }
  for (const [key, value] of Object.entries(next.data)) {
    const previousValue = previous.data[key]
    if (previousValue !== undefined && sameScalarType(previousValue, value))
      data[key] = previousValue
  }
  return { surfaceId: next.surfaceId, revision: next.revision, data }
}

export type TaskLiveViewStateStore = MutableRefObject<
  Map<string, TaskLiveViewLocalState>
>
