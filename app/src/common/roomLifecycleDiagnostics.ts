/** Local-only, bounded lifecycle evidence for Room page recovery investigations. */
export const ROOM_LIFECYCLE_DIAGNOSTIC_MAX_EVENTS = 32
export const ROOM_LIFECYCLE_DIAGNOSTIC_STORAGE_KEY =
  "free4chat.room-lifecycle.last-failed.v1"

export type RoomLifecycleNavigationType =
  | "navigate"
  | "reload"
  | "back_forward"
  | "prerender"
  | "unavailable"

export type RoomLifecycleVisibility = "visible" | "hidden" | "other"

export type TurnstileErrorFamily =
  | "110"
  | "200"
  | "300"
  | "400"
  | "600"
  | "unknown"

export type TurnstileErrorCode =
  | "110100"
  | "110110"
  | "110200"
  | "110600"
  | "110620"
  | "200100"
  | "200500"
  | "300xxx"
  | "400020"
  | "400021"
  | "400070"
  | "600xxx"
  | "unknown"

export type RoomLifecycleTurnstileStage =
  | "turnstile_script_ready"
  | "turnstile_script_error"
  | "turnstile_widget_rendered"
  | "turnstile_execute"
  | "turnstile_success"
  | "turnstile_expired"
  | "turnstile_timeout"

interface EventTiming {
  sequence: number
  elapsedMs: number
}

type RoomLifecycleDiagnosticEventData =
  RoomLifecycleDiagnosticEvent extends infer T
    ? T extends EventTiming
      ? Omit<T, keyof EventTiming>
      : never
    : never

export type RoomLifecycleDiagnosticEvent = EventTiming &
  (
    | {
        event: "page_load"
        navigationType: RoomLifecycleNavigationType
        visibility: RoomLifecycleVisibility
      }
    | {
        event: "pageshow" | "pagehide"
        persisted: boolean
        visibility: RoomLifecycleVisibility
      }
    | { event: RoomLifecycleTurnstileStage | "verification_failed" }
    | {
        event: "turnstile_error"
        family: TurnstileErrorFamily
        code: TurnstileErrorCode
      }
  )

export interface RoomLifecycleDiagnosticSnapshot {
  schemaVersion: 1
  events: RoomLifecycleDiagnosticEvent[]
}

interface TraceOptions {
  /** `null` disables lifecycle listeners. Omitted uses the browser window. */
  window?: Window | null
  /** `null` disables persistence. Omitted safely reads window.sessionStorage. */
  storage?: Storage | null
  now?: () => number
}

const EXACT_TURNSTILE_CODES = new Set<TurnstileErrorCode>([
  "110100",
  "110110",
  "110200",
  "110600",
  "110620",
  "200100",
  "200500",
  "400020",
  "400021",
  "400070",
])

export function normalizeNavigationType(
  value: unknown
): RoomLifecycleNavigationType {
  switch (value) {
    case "navigate":
    case "reload":
    case "back_forward":
    case "prerender":
      return value
    default:
      return "unavailable"
  }
}

export function normalizeVisibilityState(
  value: unknown
): RoomLifecycleVisibility {
  if (value === "visible" || value === "hidden") return value
  return "other"
}

export function normalizeTurnstileErrorCode(value: unknown): {
  family: TurnstileErrorFamily
  code: TurnstileErrorCode
} {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return { family: "unknown", code: "unknown" }

  const normalized = String(value)
  const family = normalized.slice(0, 3)
  if (/^300\d{3}$/.test(normalized)) return { family: "300", code: "300xxx" }
  if (/^600\d{3}$/.test(normalized)) return { family: "600", code: "600xxx" }

  if (EXACT_TURNSTILE_CODES.has(normalized as TurnstileErrorCode))
    return {
      family: family as TurnstileErrorFamily,
      code: normalized as TurnstileErrorCode,
    }

  return { family: "unknown", code: "unknown" }
}

function getBrowserWindow(override: Window | null | undefined): Window | null {
  if (override !== undefined) return override
  return typeof window === "undefined" ? null : window
}

function getSessionStorage(pageWindow: Window | null): Storage | null {
  try {
    return pageWindow?.sessionStorage ?? null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeStoredEvent(
  value: unknown
): RoomLifecycleDiagnosticEvent | null {
  if (!isRecord(value)) return null
  const sequence = value.sequence
  const elapsedMs = value.elapsedMs
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    typeof elapsedMs !== "number" ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > 86_400_000
  )
    return null

  const timing = { sequence, elapsedMs }
  switch (value.event) {
    case "page_load":
      return {
        ...timing,
        event: value.event,
        navigationType: normalizeNavigationType(value.navigationType),
        visibility: normalizeVisibilityState(value.visibility),
      }
    case "pageshow":
    case "pagehide":
      if (typeof value.persisted !== "boolean") return null
      return {
        ...timing,
        event: value.event,
        persisted: value.persisted,
        visibility: normalizeVisibilityState(value.visibility),
      }
    case "turnstile_error": {
      const error =
        value.code === "300xxx"
          ? { family: "300" as const, code: "300xxx" as const }
          : value.code === "600xxx"
          ? { family: "600" as const, code: "600xxx" as const }
          : normalizeTurnstileErrorCode(
              typeof value.code === "string" && /^\d+$/.test(value.code)
                ? Number(value.code)
                : NaN
            )
      return { ...timing, event: value.event, ...error }
    }
    case "verification_failed":
    case "turnstile_script_ready":
    case "turnstile_script_error":
    case "turnstile_widget_rendered":
    case "turnstile_execute":
    case "turnstile_success":
    case "turnstile_expired":
    case "turnstile_timeout":
      return { ...timing, event: value.event }
    default:
      return null
  }
}

function normalizeStoredSnapshot(
  value: unknown
): RoomLifecycleDiagnosticSnapshot | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.events)
  )
    return null
  const events = value.events
    .slice(-ROOM_LIFECYCLE_DIAGNOSTIC_MAX_EVENTS)
    .map(normalizeStoredEvent)
    .filter((event): event is RoomLifecycleDiagnosticEvent => event !== null)
  return { schemaVersion: 1, events }
}

function formatEvents(events: RoomLifecycleDiagnosticEvent[]): string[] {
  return events.map((event) => {
    const prefix = `${event.sequence} +${event.elapsedMs}ms ${event.event}`
    switch (event.event) {
      case "page_load":
        return `${prefix} navigation=${event.navigationType} visibility=${event.visibility}`
      case "pageshow":
      case "pagehide":
        return `${prefix} persisted=${event.persisted} visibility=${event.visibility}`
      case "turnstile_error":
        return `${prefix} family=${event.family} code=${event.code}`
      default:
        return prefix
    }
  })
}

export class RoomLifecycleDiagnosticTrace {
  private readonly events: RoomLifecycleDiagnosticEvent[] = []
  private readonly startedAt: number
  private readonly pageWindow: Window | null
  private readonly storage: Storage | null
  private readonly now: () => number
  private priorFailure: RoomLifecycleDiagnosticSnapshot | null
  private disposed = false
  private readonly onPageShow: (event: PageTransitionEvent) => void
  private readonly onPageHide: (event: PageTransitionEvent) => void

  constructor(options: TraceOptions = {}) {
    this.pageWindow = getBrowserWindow(options.window)
    this.storage = Object.prototype.hasOwnProperty.call(options, "storage")
      ? options.storage ?? null
      : getSessionStorage(this.pageWindow)
    const readClock =
      options.now ?? (() => this.pageWindow?.performance.now() ?? Date.now())
    this.now = () => {
      try {
        const value = readClock()
        return Number.isFinite(value) ? value : Date.now()
      } catch {
        return Date.now()
      }
    }
    this.startedAt = this.now()
    this.priorFailure = this.readLastFailure()
    this.onPageShow = (event) =>
      this.recordPageTransition("pageshow", event.persisted)
    this.onPageHide = (event) =>
      this.recordPageTransition("pagehide", event.persisted)

    if (this.pageWindow) {
      this.recordPageLoad(this.readNavigationType(), this.readVisibility())
      this.pageWindow.addEventListener("pageshow", this.onPageShow)
      this.pageWindow.addEventListener("pagehide", this.onPageHide)
    }
  }

  recordPageLoad(
    navigationType: RoomLifecycleNavigationType,
    visibility: RoomLifecycleVisibility
  ): void {
    this.push({
      event: "page_load",
      navigationType: normalizeNavigationType(navigationType),
      visibility: normalizeVisibilityState(visibility),
    })
  }

  recordPageTransition(
    event: "pageshow" | "pagehide",
    persisted: boolean
  ): void {
    if (
      (event !== "pageshow" && event !== "pagehide") ||
      typeof persisted !== "boolean"
    )
      return
    this.push({ event, persisted, visibility: this.readVisibility() })
  }

  recordTurnstileStage(stage: RoomLifecycleTurnstileStage): void {
    switch (stage) {
      case "turnstile_script_ready":
      case "turnstile_script_error":
      case "turnstile_widget_rendered":
      case "turnstile_execute":
      case "turnstile_success":
      case "turnstile_expired":
      case "turnstile_timeout":
        this.push({ event: stage })
        break
      default:
        // Runtime callers are also constrained to the fixed stage allowlist.
        break
    }
  }

  recordTurnstileError(errorCode: unknown): void {
    this.push({
      event: "turnstile_error",
      ...normalizeTurnstileErrorCode(errorCode),
    })
  }

  markVerificationFailed(): void {
    this.push({ event: "verification_failed" })
    const failed: RoomLifecycleDiagnosticSnapshot = {
      schemaVersion: 1,
      events: this.events.map((event) => ({ ...event })),
    }
    try {
      this.storage?.setItem(
        ROOM_LIFECYCLE_DIAGNOSTIC_STORAGE_KEY,
        JSON.stringify(failed)
      )
    } catch {
      // Diagnostic persistence is best-effort and never part of admission.
    }
  }

  copyText(): string {
    const prior = this.priorFailure
    const lines = ["Free4Chat Room lifecycle diagnostics v1", "", "current:"]
    lines.push(...formatEvents(this.events))
    if (prior && JSON.stringify(prior.events) !== JSON.stringify(this.events)) {
      lines.push("", "previous_failed:", ...formatEvents(prior.events))
    }
    return lines.join("\n")
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pageWindow?.removeEventListener("pageshow", this.onPageShow)
    this.pageWindow?.removeEventListener("pagehide", this.onPageHide)
  }

  private push(event: RoomLifecycleDiagnosticEventData): void {
    if (this.disposed) return
    const elapsed = Math.max(
      0,
      Math.min(86_400_000, this.now() - this.startedAt)
    )
    const next = {
      sequence: (this.events[this.events.length - 1]?.sequence ?? 0) + 1,
      elapsedMs: Math.round(elapsed),
      ...event,
    } as RoomLifecycleDiagnosticEvent
    this.events.push(next)
    if (this.events.length > ROOM_LIFECYCLE_DIAGNOSTIC_MAX_EVENTS)
      this.events.shift()
  }

  private readLastFailure(): RoomLifecycleDiagnosticSnapshot | null {
    try {
      const serialized = this.storage?.getItem(
        ROOM_LIFECYCLE_DIAGNOSTIC_STORAGE_KEY
      )
      if (!serialized) return null
      return normalizeStoredSnapshot(JSON.parse(serialized))
    } catch {
      return null
    }
  }

  private readNavigationType(): RoomLifecycleNavigationType {
    try {
      const entry =
        this.pageWindow?.performance.getEntriesByType("navigation")[0]
      return normalizeNavigationType(
        entry && "type" in entry
          ? (entry as PerformanceNavigationTiming).type
          : null
      )
    } catch {
      return "unavailable"
    }
  }

  private readVisibility(): RoomLifecycleVisibility {
    try {
      return normalizeVisibilityState(this.pageWindow?.document.visibilityState)
    } catch {
      return "other"
    }
  }
}

export const roomLifecycleDiagnostics = new RoomLifecycleDiagnosticTrace()
