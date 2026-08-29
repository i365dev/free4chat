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
  it("shows an accessible per-Agent enable control", () => {
    const props = card()
    const { getByRole } = render(<UserCard {...props} />)
    fireEvent.click(getByRole("button", { name: "Enable voice for Pi" }))
    expect(props.onToggleAgentVoice).toHaveBeenCalledOnce()
  })

  it("renders an independent enabled control and a disabled unavailable control", () => {
    const { getByRole, rerender } = render(
      <UserCard {...card({ voiceEnabled: true })} />
    )
    expect(getByRole("button", { name: "Mute Pi" })).not.toBeDisabled()
    rerender(<UserCard {...card({ voiceAvailable: false })} />)
    expect(getByRole("button", { name: "Voice unavailable" })).toBeDisabled()
  })
})
