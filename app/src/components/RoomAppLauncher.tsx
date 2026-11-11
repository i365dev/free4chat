import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react"

import type { RoomAppDefinition } from "../common/roomApp"

/**
 * #98: the lightweight in-Room App launcher.
 *
 * Progressive disclosure for a growing Lab-owned catalog: the Stage strip keeps
 * the Room plus a tiny recent/current set, and every promoted runtime stays one
 * action away here. This is a launcher, not a store — search, this Room's
 * recent Apps, and the canonical catalog labels only. It introduces no catalog
 * of its own, no ranking, no categories, no favorites and no accounts.
 */

/** The existing public App discovery page. Reached only by explicit click. */
export const ROOM_APP_DISCOVERY_URL = "https://www.free4.chat/apps"

interface RoomAppLauncherProps {
  /** The current canonical catalog (Lab-owned; Core renders labels verbatim). */
  apps: readonly RoomAppDefinition[]
  /** Recently opened Apps in this Room, most recent first. */
  recentAppIds: readonly string[]
  /** The App currently on the Stage, if any. */
  activeAppId: string | null
  /** Opens the App: same host lifecycle as the inline strip. */
  onSelect: (appId: string) => void
  onClose: () => void
  /** True at/above Core's `md` Stage/Chat split breakpoint. */
  isDesktop: boolean
  /**
   * The `Apps…` control this surface anchors to and returns focus to. The
   * control belongs to the Stage strip, so it is tracked as an element (which
   * may still be null on the first render) rather than assumed to exist.
   */
  anchorRef: RefObject<HTMLDivElement | null>
}

const VIEWPORT_MARGIN = 8
const DESKTOP_MIN_LAUNCHER_WIDTH = 320
const DESKTOP_MAX_LAUNCHER_WIDTH = 384
const DESKTOP_MAX_LAUNCHER_HEIGHT = 420

function matchesQuery(app: RoomAppDefinition, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return (
    app.label.toLowerCase().includes(needle) ||
    app.id.toLowerCase().includes(needle)
  )
}

/**
 * Ordering is presentation only: the current/recent Apps of THIS Room first,
 * then the rest of the catalog in its canonical order. No scoring, no ranking.
 */
function orderLauncherApps(
  apps: readonly RoomAppDefinition[],
  recentAppIds: readonly string[]
): RoomAppDefinition[] {
  const byId = new Map(apps.map((app) => [app.id, app]))
  const recent: RoomAppDefinition[] = []
  const placed = new Set<string>()
  for (const id of recentAppIds) {
    const app = byId.get(id)
    if (!app || placed.has(id)) continue
    placed.add(id)
    recent.push(app)
  }
  return [...recent, ...apps.filter((app) => !placed.has(app.id))]
}

function useLauncherGeometry(
  isDesktop: boolean,
  anchor: HTMLElement | null | undefined,
  launcher: HTMLElement | null
): { left: number; top: number; width: number; maxHeight: number } {
  const [geometry, setGeometry] = useState(() => ({
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
    width: DESKTOP_MIN_LAUNCHER_WIDTH,
    maxHeight: DESKTOP_MAX_LAUNCHER_HEIGHT,
  }))

  useLayoutEffect(() => {
    const measure = () => {
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const available = {
        left: VIEWPORT_MARGIN,
        right: viewportWidth - VIEWPORT_MARGIN,
      }
      if (!isDesktop) {
        // Phone: one centered, viewport-fitted surface instead of the desktop
        // anchored popover. The full catalog lives here, so the narrow Room
        // chrome never has to scroll sideways through 18+ Apps.
        const width = Math.min(viewportWidth - VIEWPORT_MARGIN * 2, 480)
        const anchorRect = anchor?.getBoundingClientRect()
        const top = Math.max(
          VIEWPORT_MARGIN,
          Math.min(
            anchorRect ? anchorRect.bottom + 4 : viewportHeight * 0.12,
            viewportHeight - VIEWPORT_MARGIN - 160
          )
        )
        setGeometry({
          left: Math.max(VIEWPORT_MARGIN, (viewportWidth - width) / 2),
          top,
          width,
          maxHeight: viewportHeight - top - VIEWPORT_MARGIN,
        })
        return
      }
      const anchorRect = anchor?.getBoundingClientRect()
      const launcherRect = launcher?.getBoundingClientRect()
      const preferredWidth =
        launcherRect?.width && launcherRect.width > 0
          ? launcherRect.width
          : DESKTOP_MAX_LAUNCHER_WIDTH
      const width = Math.min(
        Math.max(preferredWidth, DESKTOP_MIN_LAUNCHER_WIDTH),
        DESKTOP_MAX_LAUNCHER_WIDTH,
        available.right - available.left
      )
      const anchorRight = anchorRect
        ? anchorRect.right
        : available.right - VIEWPORT_MARGIN
      const left = Math.max(
        available.left,
        Math.min(anchorRight - width, available.right - width)
      )
      const top = anchorRect ? anchorRect.bottom + 4 : VIEWPORT_MARGIN + 32
      setGeometry({
        left,
        top,
        width,
        maxHeight: Math.min(
          DESKTOP_MAX_LAUNCHER_HEIGHT,
          Math.max(160, viewportHeight - top - VIEWPORT_MARGIN)
        ),
      })
    }
    measure()
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [anchor, isDesktop, launcher])

  return geometry
}

export default function RoomAppLauncher({
  apps,
  recentAppIds,
  activeAppId,
  onSelect,
  onClose,
  isDesktop,
  anchorRef,
}: RoomAppLauncherProps) {
  const launcherRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)

  const recentSet = useMemo(() => new Set(recentAppIds), [recentAppIds])
  const available = useMemo(
    () => orderLauncherApps(apps, recentAppIds),
    [apps, recentAppIds]
  )
  const results = useMemo(
    () => available.filter((app) => matchesQuery(app, query)),
    [available, query]
  )
  const recentResults = useMemo(
    () => results.filter((app) => recentSet.has(app.id)),
    [results, recentSet]
  )
  const allResults = useMemo(
    () => results.filter((app) => !recentSet.has(app.id)),
    [results, recentSet]
  )
  const activeOptionIndex =
    results.length > 0 ? Math.min(activeIndex, results.length - 1) : -1
  const activeOptionId =
    activeOptionIndex >= 0
      ? `room-app-option-${results[activeOptionIndex].id}`
      : undefined

  const anchorElement = anchorRef.current
  const geometry = useLauncherGeometry(
    isDesktop,
    anchorElement,
    launcherRef.current
  )

  useEffect(() => {
    searchRef.current?.focus()
    // Keyboard users must land back on the control that opened the launcher
    // instead of on a detached node after it closes. The element is captured
    // once at mount: re-focusing on every anchor change would steal focus from
    // the search box.
    const returnFocusTo = anchorRef.current
    return () => returnFocusTo?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      // The `Apps…` control owns its own toggle, so a click there must not be
      // handled a second time as an outside click.
      if (anchorElement?.contains(target)) return
      if (launcherRef.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [anchorElement, onClose])

  useEffect(() => {
    if (activeIndex > results.length - 1) setActiveIndex(0)
  }, [activeIndex, results.length])

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return
    const last = results.length - 1
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, last))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setActiveIndex(last)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      onSelect(results[Math.min(activeIndex, last)].id)
    }
  }

  const renderOption = (app: RoomAppDefinition) => {
    const isActive = app.id === activeAppId
    const isHighlighted = results[activeOptionIndex]?.id === app.id
    return (
      <li key={app.id} role="presentation">
        <button
          type="button"
          id={`room-app-option-${app.id}`}
          role="menuitem"
          // `aria-selected` is reserved for a *selection* concept, which this
          // launcher deliberately does not have; the current Stage App is a
          // location, so it is exposed as `aria-current`.
          aria-current={isActive ? "true" : undefined}
          // Focus stays in the search box: the highlighted row is described by
          // `aria-activedescendant`, never focused directly.
          tabIndex={-1}
          data-testid={`launcher-app-${app.id}`}
          data-active-app={isActive ? "true" : undefined}
          onMouseEnter={() => setActiveIndex(results.indexOf(app))}
          onClick={() => onSelect(app.id)}
          className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs ${
            isHighlighted ? "bg-gray-700/60" : ""
          } ${isActive ? "text-white" : "text-gray-200"} hover:bg-gray-700`}
        >
          <span className="min-w-0 flex-1 break-words">{app.label}</span>
          {isActive && (
            <span className="flex-none text-[10px] uppercase tracking-wide text-blue-300">
              Current
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/40"
        data-testid="room-app-launcher-backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
      />
      <div
        ref={launcherRef}
        role="dialog"
        aria-modal="false"
        aria-label="Apps"
        data-testid="room-app-launcher"
        style={{
          left: `${geometry.left}px`,
          top: `${geometry.top}px`,
          width: `${geometry.width}px`,
          maxHeight: `${geometry.maxHeight}px`,
          paddingBottom: isDesktop ? undefined : "env(safe-area-inset-bottom)",
        }}
        className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-gray-700 bg-gray-800 p-2 text-xs text-gray-200 shadow-2xl"
      >
        <div className="flex flex-none items-center justify-between gap-2 px-1">
          <p className="font-medium text-gray-100">Apps</p>
          <button
            type="button"
            data-testid="room-app-launcher-close"
            onClick={onClose}
            className="rounded px-2 py-1 text-gray-400 hover:bg-gray-700 hover:text-white"
          >
            Close
          </button>
        </div>
        <label htmlFor="room-app-search" className="sr-only">
          Search Apps
        </label>
        <input
          id="room-app-search"
          ref={searchRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="room-app-search-results"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search apps…"
          data-testid="room-app-search"
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={handleSearchKeyDown}
          className="mt-2 w-full flex-none rounded border-gray-600 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <div
          id="room-app-search-results"
          role="menu"
          aria-label="Apps"
          data-testid="room-app-search-results"
          className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto"
        >
          {results.length === 0 ? (
            <p
              data-testid="room-app-search-empty"
              className="px-1 py-2 text-gray-400"
            >
              No Apps match “{query.trim()}”.
            </p>
          ) : (
            <>
              {recentResults.length > 0 && (
                <div data-testid="room-app-launcher-recent">
                  <p className="px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-gray-500">
                    Recent in this Room
                  </p>
                  <ul>{recentResults.map(renderOption)}</ul>
                </div>
              )}
              {allResults.length > 0 && (
                <div data-testid="room-app-launcher-all">
                  <p className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wide text-gray-500">
                    All apps
                  </p>
                  <ul>{allResults.map(renderOption)}</ul>
                </div>
              )}
            </>
          )}
        </div>
        <div className="mt-2 flex-none border-t border-gray-700 px-1 pt-1.5">
          <a
            href={ROOM_APP_DISCOVERY_URL}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-gray-400 underline hover:text-gray-200"
          >
            Explore all apps →
          </a>
        </div>
      </div>
    </>
  )
}
