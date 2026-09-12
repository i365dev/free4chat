import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import UserCard from "./UserCard"

/**
 * #348: compact participant cards are presence cards, not capability
 * dashboards. A compact Agent card must keep the same fixed footprint as a
 * compact Human card, so the old stacked Agent badge / activity / VOICE /
 * TASK rows are gone: identity (kind glyph) rides the name line, activity is
 * a restrained avatar indicator, and Voice + Task share ONE bounded,
 * non-wrapping action row.
 *
 * jsdom cannot measure pixels, so these tests pin the structural invariant
 * that makes overflow impossible: a single fixed-height row with nowrap, and
 * no more stacked blocks than a compact Human card has.
 */

afterEach(cleanup)

function agentCard(overrides: Record<string, unknown> = {}) {
  return {
    name: "Pi",
    kind: "agent" as const,
    room: "room",
    peerId: "agent-pi",
    compact: true,
    voiceAvailable: true,
    voiceEnabled: false,
    onToggleAgentVoice: vi.fn(),
    onStartTask: vi.fn(),
    activity: "using_tools" as const,
    ...overrides,
  }
}

function compactShell(): HTMLElement {
  const shell = document.querySelector(".participant-card-shell--compact")
  expect(shell).toBeTruthy()
  return shell as HTMLElement
}

/** Visible stacked blocks of the compact card (audio is layout-invisible). */
function stackedBlocks(shell: HTMLElement): Element[] {
  const card = shell.firstElementChild as HTMLElement
  return Array.from(card.children).filter((el) => el.tagName !== "AUDIO")
}

describe("compact Agent card density (#348)", () => {
  it("keeps a fully loaded Agent inside one bounded, non-wrapping action row", () => {
    const { getByTestId, getByRole } = render(<UserCard {...agentCard()} />)

    const row = getByTestId("compact-agent-controls")
    const voice = getByRole("button", { name: "Enable voice for Pi" })
    const task = getByRole("button", { name: "Start task with Pi" })

    // VOICE and TASK share exactly one parent row: they can never restack.
    expect(voice.parentElement).toBe(row)
    expect(task.parentElement).toBe(row)
    expect(row).toHaveClass("flex-nowrap")
    expect(row).not.toHaveClass("flex-wrap")
    // The fixed row height bounds what the action row can add to the card.
    expect(row).toHaveClass("h-6")

    // No wrapping container survives anywhere in the compact card.
    expect(compactShell().querySelectorAll(".flex-wrap").length).toBe(0)
  })

  it("does not stack more visible rows than a compact Human card", () => {
    const human = render(
      <UserCard
        name="Hannah"
        kind="human"
        room="room"
        peerId="local-peer"
        compact
        onMuteSelf={vi.fn()}
      />
    )
    const humanBlocks = stackedBlocks(compactShell())
    human.unmount()

    render(<UserCard {...agentCard()} />)
    const agentBlocks = stackedBlocks(compactShell())

    // avatar + identity line + ONE action row, exactly like the compact Human
    // card (avatar + name + self actions). Agent-only controls no longer add a
    // further block — that extra block is what pushed TASK below the shell.
    expect(agentBlocks.map((el) => el.tagName)).toEqual(
      humanBlocks.map((el) => el.tagName)
    )
    expect(agentBlocks.length).toBe(3)
  })

  it("keeps Agent identity and activity out of the vertical control stack", () => {
    const { getByTestId } = render(<UserCard {...agentCard()} />)

    const kind = getByTestId("compact-agent-kind")
    expect(kind).toHaveAccessibleName("Agent")
    // Identity rides the truncated name line instead of its own badge row.
    expect(kind.closest("p")).toBeTruthy()
    expect(kind.closest('[data-testid="compact-agent-controls"]')).toBeNull()

    const activity = getByTestId("agent-activity")
    expect(activity).toHaveAccessibleName("Using tools")
    expect(activity.getAttribute("title")).toBe("Using tools")
    // Activity is a compact avatar indicator with a tooltip, not a text row.
    expect(activity.closest(".participant-card__avatar")).toBeTruthy()
    expect(
      activity.closest('[data-testid="compact-agent-controls"]')
    ).toBeNull()
  })

  it("keeps compact Voice and Task clickable in the shared action row", () => {
    const props = agentCard()
    const { getByRole } = render(<UserCard {...props} />)

    fireEvent.click(getByRole("button", { name: "Enable voice for Pi" }))
    expect(props.onToggleAgentVoice).toHaveBeenCalledWith("agent-pi", true)

    fireEvent.click(getByRole("button", { name: "Start task with Pi" }))
    expect(props.onStartTask).toHaveBeenCalledWith("agent-pi", "Pi")
  })

  it("keeps the enabled Voice state on the same single icon row", () => {
    const { getByRole, getByTestId } = render(
      <UserCard {...agentCard({ voiceEnabled: true })} />
    )

    const voice = getByRole("button", { name: "Mute Pi" })
    const row = getByTestId("compact-agent-controls")
    expect(voice.parentElement).toBe(row)
    expect(row).toHaveClass("flex-nowrap")
  })

  it("omits the action row entirely for an Agent without controls", () => {
    const { queryByTestId } = render(
      <UserCard
        {...agentCard({
          voiceAvailable: false,
          onStartTask: undefined,
          activity: undefined,
        })}
      />
    )

    expect(queryByTestId("compact-agent-controls")).toBeNull()
    expect(queryByTestId("agent-activity")).toBeNull()
  })
})
