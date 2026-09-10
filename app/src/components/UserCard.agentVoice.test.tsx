import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import UserCard from "./UserCard"

function card(overrides: Record<string, unknown> = {}) {
  return {
    name: "Pi",
    kind: "agent" as const,
    room: "room",
    peerId: "pi",
    voiceAvailable: true,
    voiceEnabled: false,
    onToggleAgentVoice: vi.fn(),
    ...overrides,
  }
}

describe("UserCard Agent Voice", () => {
  it("renders only the coarse transient Agent activity label", () => {
    const { getByTestId } = render(
      <UserCard {...card({ activity: "using_tools" })} />
    )
    expect(getByTestId("agent-activity")).toHaveTextContent("Using tools")
  })

  it("shows an accessible per-Agent enable control", () => {
    const props = card()
    const { getByRole } = render(<UserCard {...props} />)
    fireEvent.click(getByRole("button", { name: "Enable voice for Pi" }))
    expect(props.onToggleAgentVoice).toHaveBeenCalledOnce()
  })

  it("renders enabled controls independently and hides unavailable voice", () => {
    const { getByRole, queryByRole, rerender } = render(
      <UserCard {...card({ voiceEnabled: true })} />
    )
    expect(getByRole("button", { name: "Mute Pi" })).not.toBeDisabled()
    rerender(<UserCard {...card({ voiceAvailable: false })} />)
    expect(queryByRole("button", { name: "Voice unavailable" })).toBeNull()
  })
})
