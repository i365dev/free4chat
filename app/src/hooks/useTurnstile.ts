import { useCallback, useEffect, useRef, useState } from "react"

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: Record<string, unknown>
      ) => string
      execute: (
        container: string | HTMLElement,
        options?: Record<string, unknown>
      ) => void
      reset: (widgetId?: string) => void
      remove: (widgetId?: string) => void
    }
  }
}

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

// Cloudflare's published "always passes" test sitekey. Used automatically
// when NEXT_PUBLIC_TURNSTILE_SITE_KEY is not configured (local dev).
const TURNSTILE_SITEKEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000"

// Build-time kill switch for fully offline/local stacks: bake
// NEXT_PUBLIC_TURNSTILE_DISABLED=1 and the widget never loads while
// requestToken() resolves immediately with a placeholder (the server skips
// verification too when its secret is empty). Production builds leave it
// unset, so real verification is untouched.

let scriptPromise: Promise<void> | null = null

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("turnstile_unavailable"))
  if (window.turnstile) return Promise.resolve()
  if (!scriptPromise) {
    // Always create a brand-new <script> element for this attempt. Reusing
    // whatever the DOM happens to have is what caused the retry hang: a
    // previously-failed element has already fired its one-shot "error"
    // event, so listeners attached to it after the fact never fire and the
    // returned promise never settles.
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script")
      script.src = TURNSTILE_SCRIPT_SRC
      script.async = true
      script.defer = true
      const onReady = () => resolve()
      const onFail = () => {
        script.removeEventListener("load", onReady)
        script.removeEventListener("error", onFail)
        script.remove()
        scriptPromise = null
        reject(new Error("turnstile_script_failed"))
      }
      script.addEventListener("load", onReady, { once: true })
      script.addEventListener("error", onFail, { once: true })
      document.head.appendChild(script)
    })
  }
  return scriptPromise
}

export type TurnstileStatus = "idle" | "loading" | "verifying" | "error"

interface Settlement {
  resolve: (token: string) => void
  reject: (error: Error) => void
}

/**
 * Action-scoped Turnstile challenge. Unlike a page-wide gate, this renders a
 * bounded (appearance: interaction-only) widget that stays invisible unless
 * Cloudflare decides interaction is required, and only runs a challenge when
 * requestToken() is called. Every call resets the widget first, so a token
 * is never reused across two protected actions.
 */
export function useTurnstile() {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const settlementRef = useRef<Settlement | null>(null)
  const pendingRef = useRef<Promise<string> | null>(null)
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<TurnstileStatus>("idle")

  // Tears down the actual Cloudflare-owned widget UI (which is not
  // guaranteed to live only inside our container element — Turnstile can
  // position it as a body-level overlay) and clears the id so the next
  // ensureWidget() call always renders a genuinely fresh widget rather than
  // reusing one that has already settled.
  const removeWidget = useCallback(() => {
    const ts = window.turnstile
    const widgetId = widgetIdRef.current
    widgetIdRef.current = null
    if (widgetId && ts) {
      try {
        ts.remove(widgetId)
      } catch {
        // The widget may already be gone (e.g. script never finished loading).
      }
    }
  }, [])

  const settle = useCallback(
    (token?: string, error?: Error) => {
      const settlement = settlementRef.current
      settlementRef.current = null
      if (!settlement) return
      // Every settlement — success or failure — is terminal for this widget
      // instance: a completed challenge must not linger visibly once the
      // protected action has resolved, and a failed one must not be reused
      // by a retry (see requestToken()'s reset-before-execute comment).
      removeWidget()
      if (!mountedRef.current) return
      if (error) {
        setStatus("error")
        settlement.reject(error)
      } else {
        setStatus("idle")
        settlement.resolve(token as string)
      }
    },
    [removeWidget]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      removeWidget()
      settlementRef.current = null
      pendingRef.current = null
    }
  }, [removeWidget])

  const ensureWidget = useCallback(async (): Promise<string> => {
    if (widgetIdRef.current) return widgetIdRef.current
    setStatus("loading")
    await loadTurnstileScript()
    const ts = window.turnstile
    const container = containerRef.current
    if (!ts || !container) throw new Error("turnstile_unavailable")
    const widgetId = ts.render(container, {
      sitekey: TURNSTILE_SITEKEY,
      appearance: "interaction-only",
      execution: "execute",
      retry: "never",
      "refresh-expired": "manual",
      callback: (token: string) => settle(token),
      "error-callback": () => {
        settle(undefined, new Error("turnstile_error"))
        return false
      },
      "expired-callback": () =>
        settle(undefined, new Error("turnstile_expired")),
      "timeout-callback": () =>
        settle(undefined, new Error("turnstile_timeout")),
    })
    widgetIdRef.current = widgetId
    return widgetId
  }, [settle])

  /** Resolves with a freshly generated, single-use Turnstile token. */
  const requestToken = useCallback((): Promise<string> => {
    if (pendingRef.current) return pendingRef.current
    if (process.env.NEXT_PUBLIC_TURNSTILE_DISABLED === "1")
      return Promise.resolve("turnstile-disabled")

    const run = async (): Promise<string> => {
      const widgetId = await ensureWidget()
      const ts = window.turnstile
      const container = containerRef.current
      if (!ts || !container) throw new Error("turnstile_unavailable")
      return await new Promise<string>((resolve, reject) => {
        settlementRef.current = { resolve, reject }
        setStatus("verifying")
        try {
          // Reset first so a stale/consumed token can never be handed back.
          ts.reset(widgetId)
          ts.execute(container)
        } catch (err) {
          settlementRef.current = null
          reject(
            err instanceof Error ? err : new Error("turnstile_execute_failed")
          )
        }
      })
    }

    const promise = run().finally(() => {
      pendingRef.current = null
    })
    pendingRef.current = promise
    return promise
  }, [ensureWidget])

  return { containerRef, requestToken, status }
}
