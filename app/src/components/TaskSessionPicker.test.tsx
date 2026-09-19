import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { RelayTaskSession } from "@do/taskSession"

import TaskSessionPicker from "./TaskSessionPicker"

/**
 * #409 Task Session Continuation — the bounded session picker.
 *
 * The picker must stay COMPACT (a few rows with internal scroll, explicit
 * pagination) and must treat a Harness title as untrusted plain text.
 */

const sessions: RelayTaskSession[] = [
  {
    token: "token-1",
    title: "Fix shooter interpolation",
    projectToken: "project-1",
    projectLabel: "~/workspace/free4chat",
    updatedAt: new Date(Date.now() - 38 * 60 * 1000).toISOString(),
  },
  {
    token: "token-2",
    title: "记住这个测试暗号：HANDOFF-7391",
    projectToken: "project-2",
    projectLabel: "/private/tmp",
    updatedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  },
  {
    token: "token-3",
    title: "Analyze OHLC cache",
    projectToken: "project-3",
    projectLabel: "~/workspace/myInvestPilot",
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
]

const projects = [
  { token: "project-1", label: "~/workspace/free4chat" },
  { token: "project-2", label: "/private/tmp" },
  { token: "project-3", label: "~/workspace/myInvestPilot" },
]

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof TaskSessionPicker>> = {}
) {
  const props = {
    status: "ready" as const,
    sessions,
    projects,
    hasMore: false,
    loadingMore: false,
    error: "",
    selectedToken: null,
    projectToken: null,
    onSelect: vi.fn(),
    onProjectChange: vi.fn(),
    onLoadMore: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<TaskSessionPicker {...props} />) }
}

describe("TaskSessionPicker (#409)", () => {
  it("renders recent sessions with title, project path, and relative age", () => {
    renderPicker()
    expect(screen.getByTestId("task-session-list")).toBeInTheDocument()
    expect(screen.getAllByTestId("task-session-row")).toHaveLength(3)
    expect(screen.getByText("Fix shooter interpolation")).toBeInTheDocument()
    expect(
      screen.getByText("记住这个测试暗号：HANDOFF-7391")
    ).toBeInTheDocument()
    expect(
      screen.getByText(/~\/workspace\/free4chat · 38 min ago/)
    ).toBeInTheDocument()
    expect(screen.getByText(/\/private\/tmp · 12 min ago/)).toBeInTheDocument()
    expect(
      screen.getByText(/~\/workspace\/myInvestPilot · 2 h ago/)
    ).toBeInTheDocument()
  })

  it("bounds the list height and never paginates automatically", () => {
    renderPicker()
    // Internal scroll, not a modal-stretching list.
    expect(screen.getByTestId("task-session-list").className).toContain(
      "max-h-60"
    )
    expect(screen.getByTestId("task-session-list").className).toContain(
      "overflow-y-auto"
    )
    // Load more is explicit and absent when there is nothing more.
    expect(screen.queryByTestId("task-session-load-more")).toBeNull()
  })

  it("offers an explicit Load more only when the Runtime reported more", () => {
    const onLoadMore = vi.fn()
    renderPicker({ hasMore: true, onLoadMore })
    fireEvent.click(screen.getByTestId("task-session-load-more"))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it("shows a loading state before any rows exist", () => {
    renderPicker({ status: "loading", sessions: [] })
    expect(screen.getByTestId("task-session-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("task-session-list")).toBeNull()
  })

  it("shows an empty state distinct from a filtered-empty state", () => {
    renderPicker({ sessions: [] })
    expect(screen.getByTestId("task-session-empty")).toHaveTextContent(
      "No local sessions found for this Agent."
    )
  })

  it("shows an actionable error with a refresh control", () => {
    const onRefresh = vi.fn()
    renderPicker({
      status: "error",
      sessions: [],
      error:
        "This local session is no longer available. Refresh sessions and try again.",
      onRefresh,
    })
    expect(screen.getByTestId("task-session-error")).toHaveTextContent(
      "This local session is no longer available."
    )
    fireEvent.click(screen.getByTestId("task-session-retry"))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("offers an explicit Refresh that is never satisfied by loaded rows alone", () => {
    const onRefresh = vi.fn()
    renderPicker({ onRefresh })
    const refresh = screen.getByTestId("task-session-refresh")
    expect(refresh).toHaveTextContent("Refresh")
    fireEvent.click(refresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("reports a refresh in flight and blocks a duplicate one", () => {
    const onRefresh = vi.fn()
    renderPicker({ onRefresh, refreshing: true })
    const refresh = screen.getByTestId("task-session-refresh")
    expect(refresh).toHaveTextContent("Refreshing…")
    expect(refresh).toBeDisabled()
    fireEvent.click(refresh)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("filters the already-loaded rows case-insensitively", () => {
    renderPicker()
    fireEvent.change(screen.getByTestId("task-session-search"), {
      target: { value: "ohlc" },
    })
    expect(screen.getAllByTestId("task-session-row")).toHaveLength(1)
    expect(screen.getByText("Analyze OHLC cache")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("task-session-search"), {
      target: { value: "nothing-matches" },
    })
    expect(screen.queryAllByTestId("task-session-row")).toHaveLength(0)
    expect(screen.getByTestId("task-session-empty")).toHaveTextContent(
      "No sessions match"
    )
  })

  it("reports the selection and marks the chosen row", () => {
    const onSelect = vi.fn()
    renderPicker({ onSelect, selectedToken: "token-2" })
    const rows = screen.getAllByTestId("task-session-row")
    expect(rows[1]).toHaveAttribute("aria-selected", "true")
    expect(rows[0]).toHaveAttribute("aria-selected", "false")
    fireEvent.click(rows[0])
    expect(onSelect).toHaveBeenCalledWith(sessions[0])
  })

  it("offers Recent plus the discovered projects and filters by project token", () => {
    const onProjectChange = vi.fn()
    renderPicker({ onProjectChange })
    expect(screen.getByTestId("task-session-project-toggle")).toHaveTextContent(
      "Project: Recent"
    )
    fireEvent.click(screen.getByTestId("task-session-project-toggle"))
    expect(
      screen.getByTestId("task-session-project-recent")
    ).toBeInTheDocument()
    expect(screen.getAllByTestId("task-session-project-option")).toHaveLength(3)

    // The project filter is a bounded, searchable popover.
    fireEvent.change(screen.getByTestId("task-session-project-search"), {
      target: { value: "tmp" },
    })
    expect(screen.getAllByTestId("task-session-project-option")).toHaveLength(1)
    fireEvent.click(screen.getAllByTestId("task-session-project-option")[0])
    expect(onProjectChange).toHaveBeenCalledWith("project-2")
  })

  it("renders an untrusted title as plain text, never as markup", () => {
    const hostile = '<img src=x onerror="window.__pwned=1">'
    const { container } = renderPicker({
      sessions: [
        {
          token: "token-x",
          title: hostile,
          projectToken: "project-1",
          projectLabel: "<b>project</b>",
        },
      ],
    })
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
    expect(screen.getByText(hostile)).toBeInTheDocument()
    expect(screen.getByText("<b>project</b>")).toBeInTheDocument()
  })

  it("keeps a long untrusted title from breaking a narrow layout", () => {
    renderPicker({
      sessions: [
        {
          token: "token-x",
          title: "long-title-".repeat(40),
          projectToken: "project-1",
          projectLabel: "/very/long/project/path/".repeat(10),
        },
      ],
    })
    const title = screen.getByText(/^long-title-/)
    expect(title.className).toContain("break-words")
    expect(title.className).toContain("min-w-0")
  })

  it("disables every control while a Start is in flight", () => {
    renderPicker({ disabled: true, hasMore: true })
    expect(screen.getByTestId("task-session-load-more")).toBeDisabled()
    for (const row of screen.getAllByTestId("task-session-row"))
      expect(row).toBeDisabled()
    expect(screen.getByTestId("task-session-project-toggle")).toBeDisabled()
  })
})
