import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useTurnstile } from "./useTurnstile"

interface RenderOptions {
  callback: (token: string) => void
  "error-callback": () => boolean | void
  "expired-callback": () => void
  "timeout-callback": () => void
  appearance: string
  execution: string
  sitekey: string
}

function installMockTurnstile() {
  let widgetCounter = 0
  let lastOptions: RenderOptions | null = null
  const render = vi.fn(
    (_container: string | HTMLElement, options: Record<string, unknown>) => {
      lastOptions = options as unknown as RenderOptions
      widgetCounter += 1
      return `widget-${widgetCounter}`
    }
  )
  const execute = vi.fn()
  const reset = vi.fn()
  const remove = vi.fn()

  window.turnstile = { render, execute, reset, remove }

  return {
    render,
    execute,
    reset,
    remove,
    fireSuccess: (token: string) => lastOptions?.callback(token),
    fireError: () => lastOptions?.["error-callback"](),
    fireExpired: () => lastOptions?.["expired-callback"](),
    fireTimeout: () => lastOptions?.["timeout-callback"](),
    getLastOptions: () => lastOptions,
  }
}

describe("useTurnstile", () => {
  let mock: ReturnType<typeof installMockTurnstile>

  beforeEach(() => {
    mock = installMockTurnstile()
  })

  afterEach(() => {
    delete (window as { turnstile?: unknown }).turnstile
    vi.restoreAllMocks()
  })

  function attachContainer(result: {
    current: { containerRef: React.RefObject<HTMLDivElement> }
  }) {
    const div = document.createElement("div")
    document.body.appendChild(div)
    ;(result.current.containerRef as { current: HTMLDivElement }).current = div
  }

  it("renders an interaction-only, execute-mode widget and resolves with the token from the callback", async () => {
    const { result } = renderHook(() => useTurnstile())
    attachContainer(result)

    let tokenPromise: Promise<string> | undefined
    act(() => {
      tokenPromise = result.current.requestToken()
    })

    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    expect(mock.render).toHaveBeenCalledTimes(1)
    expect(mock.getLastOptions()?.appearance).toBe("interaction-only")
    expect(mock.getLastOptions()?.execution).toBe("execute")
    expect(mock.reset).toHaveBeenCalledTimes(1)

    act(() => {
      mock.fireSuccess("token-1")
    })

    await expect(tokenPromise).resolves.toBe("token-1")
  })

  it("never reuses a token: every requestToken() call resets first and returns a fresh value", async () => {
    const { result } = renderHook(() => useTurnstile())
    attachContainer(result)

    let first: Promise<string> | undefined
    act(() => {
      first = result.current.requestToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    act(() => {
      mock.fireSuccess("token-1")
    })
    await expect(first).resolves.toBe("token-1")

    let second: Promise<string> | undefined
    act(() => {
      second = result.current.requestToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(2))
    act(() => {
      mock.fireSuccess("token-2")
    })
    await expect(second).resolves.toBe("token-2")

    // The widget is rendered once and reused; every call resets it first so a
    // consumed/stale token can never be handed back.
    expect(mock.render).toHaveBeenCalledTimes(1)
    expect(mock.reset).toHaveBeenCalledTimes(2)
  })

  it("rejects on error-callback and allows a fresh retry afterwards", async () => {
    const { result } = renderHook(() => useTurnstile())
    attachContainer(result)

    let failing: Promise<string> | undefined
    act(() => {
      failing = result.current.requestToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    act(() => {
      mock.fireError()
    })
    await expect(failing).rejects.toThrow()

    let retry: Promise<string> | undefined
    act(() => {
      retry = result.current.requestToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(2))
    act(() => {
      mock.fireSuccess("token-after-retry")
    })
    await expect(retry).resolves.toBe("token-after-retry")
  })

  it("rejects on expired-callback and on timeout-callback", async () => {
    const { result } = renderHook(() => useTurnstile())
    attachContainer(result)

    let expired: Promise<string> | undefined
    act(() => {
      expired = result.current.requestToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    act(() => {
      mock.fireExpired()
    })
    await expect(expired).rejects.toThrow()

    let timedOut: Promise<string> | undefined
    act(() => {
      timedOut = result.current.requestToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(2))
    act(() => {
      mock.fireTimeout()
    })
    await expect(timedOut).rejects.toThrow()
  })

  it("dedupes concurrent requestToken() calls into a single in-flight challenge", async () => {
    const { result } = renderHook(() => useTurnstile())
    attachContainer(result)

    let first: Promise<string> | undefined
    let second: Promise<string> | undefined
    act(() => {
      first = result.current.requestToken()
      second = result.current.requestToken()
    })

    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))

    act(() => {
      mock.fireSuccess("shared-token")
    })

    await expect(first).resolves.toBe("shared-token")
    await expect(second).resolves.toBe("shared-token")
  })
})

describe("useTurnstile — script load retry", () => {
  const SCRIPT_SELECTOR = 'script[src*="challenges.cloudflare.com/turnstile"]'

  afterEach(() => {
    delete (window as { turnstile?: unknown }).turnstile
    document.querySelectorAll(SCRIPT_SELECTOR).forEach((el) => el.remove())
    vi.restoreAllMocks()
  })

  function attachContainer(result: {
    current: { containerRef: React.RefObject<HTMLDivElement> }
  }) {
    const div = document.createElement("div")
    document.body.appendChild(div)
    ;(result.current.containerRef as { current: HTMLDivElement }).current = div
  }

  it("removes a failed script element, starts a genuinely fresh load on retry, and can still succeed", async () => {
    const { result } = renderHook(() => useTurnstile())
    attachContainer(result)

    let failing: Promise<string> | undefined
    act(() => {
      failing = result.current.requestToken()
    })

    await waitFor(() =>
      expect(document.querySelectorAll(SCRIPT_SELECTOR).length).toBe(1)
    )
    const firstScript =
      document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR)
    expect(firstScript).not.toBeNull()

    act(() => {
      firstScript!.dispatchEvent(new Event("error"))
    })
    await expect(failing).rejects.toThrow()

    // The failed element must not linger in the DOM — a stale element has
    // already fired its one-shot "error" event, so a retry that reused it
    // would wait forever for events that can never happen again.
    expect(document.contains(firstScript!)).toBe(false)

    let retrying: Promise<string> | undefined
    act(() => {
      retrying = result.current.requestToken()
    })

    await waitFor(() =>
      expect(document.querySelectorAll(SCRIPT_SELECTOR).length).toBe(1)
    )
    const secondScript =
      document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR)
    expect(secondScript).not.toBeNull()
    expect(secondScript).not.toBe(firstScript)

    // Simulate the real script succeeding this time: it sets window.turnstile
    // before firing "load".
    const mock = installMockTurnstile()
    act(() => {
      secondScript!.dispatchEvent(new Event("load"))
    })

    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    act(() => {
      mock.fireSuccess("token-after-script-retry")
    })

    await expect(retrying).resolves.toBe("token-after-script-retry")
  })
})
