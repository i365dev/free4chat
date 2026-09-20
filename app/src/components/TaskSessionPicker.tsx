"use client"

import { useCallback, useMemo, useRef, useState } from "react"

import {
  filterTaskSessions,
  type RelayTaskSession,
  type RelayTaskSessionProject,
} from "@do/taskSession"

/*
 * #409 Task Session Continuation — the bounded session picker inside the
 * Start Task modal.
 *
 * Deliberately compact and deliberately NOT a workspace browser:
 *
 *   - at most 10 rows per page, ~240px of internal scroll, explicit Load more;
 *   - the project selector is a bounded searchable popover, not a giant
 *     dropdown that stretches the modal;
 *   - search filters only the rows ALREADY loaded (no index, no filesystem
 *     walk, no server-side search surface);
 *   - a session title is UNTRUSTED presentation and is rendered as plain text
 *     with break-words — never HTML, never markdown.
 *
 * It renders no filesystem tree and never scans a local directory: every
 * project here came from a Harness session descriptor.
 */

export interface TaskSessionPickerProps {
  status: "idle" | "loading" | "ready" | "error"
  sessions: RelayTaskSession[]
  projects: RelayTaskSessionProject[]
  hasMore: boolean
  loadingMore: boolean
  error: string
  selectedToken: string | null
  projectToken: string | null
  onSelect: (row: RelayTaskSession) => void
  onProjectChange: (token: string | null) => void
  onLoadMore: () => void
  /**
   * Re-runs discovery through the Runtime -> Harness `session/list` round
   * trip. This is deliberately NOT a re-render of already-loaded rows: the
   * Room re-asks the resident Runtime, which re-asks the Harness, so a
   * provider that gained or lost a session since the last look is reflected
   * immediately.
   */
  onRefresh: () => void
  refreshing?: boolean
  disabled?: boolean
}

const RECENT_LABEL = "Recent"

/**
 * #421: production dogfood showed that a real local project path such as
 * `/private/var/folders/…/T/xyz` makes the bounded project popover awkward —
 * the DISTINGUISHING part of the path is its tail, and it was the part pushed
 * out of view.
 *
 * This is a bounded PRESENTATION-ONLY compaction of the Runtime's display
 * label. It deliberately does not touch #420's semantics:
 *
 *   - the label is already presentation-only and the Runtime never resolves a
 *     cwd from it, so nothing here becomes an identifier;
 *   - no token, cwd, or session id is added to browser state — the same single
 *     string is only rendered shorter;
 *   - search still matches the FULL label, so a Human can always find a
 *     project by any part of its path;
 *   - the untouched label stays available as the element's `title`.
 *
 * The tail is what distinguishes projects, so it is preserved and only the
 * redundant leading segments are elided.
 */
export function compactProjectLabel(label: string, maxLength = 44): string {
  const trimmed = label.trim()
  if (trimmed.length <= maxLength) return trimmed
  const segments = trimmed.split("/").filter((segment) => segment.length > 0)
  if (segments.length <= 1) return clampLabel(trimmed, maxLength)
  // A home-relative path keeps its `~`: that is real, useful context and never
  // the long part. It is reserved up front so the elided label as a whole stays
  // inside the bound.
  const prefix = segments[0] === "~" ? "~/" : ""
  const budget = maxLength - prefix.length
  const tail: string[] = []
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = [segments[index], ...tail]
    if (`…/${candidate.join("/")}`.length > budget) break
    tail.unshift(segments[index])
  }
  if (tail.length === 0)
    return `${prefix}…/${clampLabel(
      segments[segments.length - 1],
      Math.max(1, budget - 2)
    )}`
  return `${prefix}…/${tail.join("/")}`
}

function clampLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(1, maxLength - 1))}…`
}

export default function TaskSessionPicker({
  status,
  sessions,
  projects,
  hasMore,
  loadingMore,
  error,
  selectedToken,
  projectToken,
  onSelect,
  onProjectChange,
  onLoadMore,
  onRefresh,
  refreshing = false,
  disabled = false,
}: TaskSessionPickerProps) {
  const [query, setQuery] = useState("")
  const [projectOpen, setProjectOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState("")
  const searchRef = useRef<HTMLInputElement | null>(null)
  const projectSearchRef = useRef<HTMLInputElement | null>(null)

  const visible = useMemo(
    () => filterTaskSessions(sessions, query),
    [sessions, query]
  )
  const selectedProject = useMemo(
    () =>
      projects.find((candidate) => candidate.token === projectToken) ?? null,
    [projects, projectToken]
  )
  const visibleProjects = useMemo(() => {
    const needle = projectQuery.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter((candidate) =>
      candidate.label.toLowerCase().includes(needle)
    )
  }, [projects, projectQuery])

  const closeProjectSelector = useCallback(() => {
    setProjectOpen(false)
    setProjectQuery("")
  }, [])

  const handleProjectKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        closeProjectSelector()
      }
    },
    [closeProjectSelector]
  )

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="min-w-0 flex-1 truncate text-xs text-gray-400"
          data-testid="task-session-project-summary"
          title={selectedProject ? selectedProject.label : undefined}
        >
          {selectedProject
            ? compactProjectLabel(selectedProject.label)
            : RECENT_LABEL}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="task-session-refresh"
            onClick={onRefresh}
            disabled={disabled || refreshing}
            aria-label="Refresh sessions"
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-800 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <div className="relative">
            <button
              type="button"
              data-testid="task-session-project-toggle"
              aria-haspopup="listbox"
              aria-expanded={projectOpen}
              disabled={disabled}
              onClick={() => {
                const next = !projectOpen
                setProjectOpen(next)
                setProjectQuery("")
                if (next)
                  queueMicrotask(() => projectSearchRef.current?.focus())
              }}
              className="max-w-[10rem] truncate rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-800 disabled:opacity-50"
              title={selectedProject ? selectedProject.label : undefined}
            >
              Project:{" "}
              {selectedProject
                ? compactProjectLabel(selectedProject.label)
                : RECENT_LABEL}{" "}
              ▾
            </button>
            {projectOpen && (
              <div
                data-testid="task-session-project-menu"
                role="listbox"
                aria-label="Session projects"
                onKeyDown={handleProjectKeyDown}
                className="absolute right-0 z-10 mt-1 w-60 rounded-lg border border-gray-700 bg-gray-950 p-2 shadow-2xl"
              >
                <input
                  ref={projectSearchRef}
                  type="text"
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  placeholder="Search projects…"
                  aria-label="Search projects"
                  data-testid="task-session-project-search"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
                {/* Bounded: the Runtime caps the project catalog, and this caps
                  the rendered height rather than the modal. */}
                <div className="scrollbar-thin mt-1 max-h-40 overflow-y-auto">
                  <button
                    type="button"
                    role="option"
                    aria-selected={projectToken === null}
                    data-testid="task-session-project-recent"
                    onClick={() => {
                      onProjectChange(null)
                      closeProjectSelector()
                    }}
                    className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
                      projectToken === null
                        ? "bg-blue-600/20 text-blue-100"
                        : "text-gray-200 hover:bg-gray-800"
                    }`}
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {RECENT_LABEL}
                    </span>
                  </button>
                  {visibleProjects.map((project) => (
                    <button
                      key={project.token}
                      type="button"
                      role="option"
                      aria-selected={projectToken === project.token}
                      data-testid="task-session-project-option"
                      onClick={() => {
                        onProjectChange(project.token)
                        closeProjectSelector()
                      }}
                      className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
                        projectToken === project.token
                          ? "bg-blue-600/20 text-blue-100"
                          : "text-gray-200 hover:bg-gray-800"
                      }`}
                    >
                      {/* Untrusted display path, compacted for the bounded
                        popover. The full label stays in `title`; the search
                        field above still matches the FULL label. */}
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={project.label}
                      >
                        {compactProjectLabel(project.label)}
                      </span>
                    </button>
                  ))}
                  {visibleProjects.length === 0 && (
                    <p className="px-1 py-2 text-[11px] text-gray-400">
                      No projects match “{projectQuery.trim()}”.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {status === "loading" && (
        <p
          data-testid="task-session-loading"
          className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-4 text-xs text-gray-400"
        >
          Loading local sessions…
        </p>
      )}

      {status === "error" && (
        <div
          data-testid="task-session-error"
          className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-4 text-xs text-rose-300"
        >
          <p>{error}</p>
          <button
            type="button"
            data-testid="task-session-retry"
            onClick={onRefresh}
            className="mt-2 rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-800"
          >
            Refresh sessions
          </button>
        </div>
      )}

      {status === "ready" && (
        <>
          {sessions.length > 0 && (
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions…"
              aria-label="Search sessions"
              data-testid="task-session-search"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="mb-2 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          )}
          {/* ~240px of internal scroll; never hundreds of rows. */}
          <div
            role="listbox"
            aria-label="Recent local sessions"
            data-testid="task-session-list"
            className="scrollbar-thin max-h-60 overflow-y-auto rounded-lg border border-gray-800"
          >
            {visible.map((row) => (
              <button
                key={row.token}
                type="button"
                role="option"
                aria-selected={selectedToken === row.token}
                data-testid="task-session-row"
                onClick={() => onSelect(row)}
                disabled={disabled}
                className={`flex w-full flex-col gap-0.5 border-b border-gray-800 px-3 py-2 text-left last:border-b-0 ${
                  selectedToken === row.token
                    ? "bg-blue-600/20"
                    : "hover:bg-gray-800"
                } disabled:opacity-50`}
              >
                <span className="min-w-0 break-words text-xs text-white">
                  {row.title || "Untitled session"}
                </span>
                <span
                  className="min-w-0 truncate text-[11px] text-gray-400"
                  title={row.projectLabel}
                >
                  {compactProjectLabel(row.projectLabel)}
                  {relativeUpdatedAt(row.updatedAt)
                    ? ` · ${relativeUpdatedAt(row.updatedAt)}`
                    : ""}
                </span>
              </button>
            ))}
            {visible.length === 0 && (
              <p
                data-testid="task-session-empty"
                className="px-3 py-4 text-xs text-gray-400"
              >
                {sessions.length === 0
                  ? "No local sessions found for this Agent."
                  : `No sessions match “${query.trim()}”.`}
              </p>
            )}
          </div>
          {hasMore && (
            <div className="mt-2 flex justify-center">
              <button
                type="button"
                data-testid="task-session-load-more"
                onClick={onLoadMore}
                disabled={disabled || loadingMore}
                className="rounded-md border border-gray-700 px-3 py-1 text-[11px] text-gray-200 hover:bg-gray-800 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Renders one bounded relative age from an already-validated RFC3339 string.
 * An unparseable value renders nothing rather than an "Invalid Date".
 */
function relativeUpdatedAt(updatedAt: string | undefined): string {
  if (!updatedAt) return ""
  const parsed = Date.parse(updatedAt)
  if (!Number.isFinite(parsed)) return ""
  const elapsed = Date.now() - parsed
  if (elapsed < 0) return ""
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
