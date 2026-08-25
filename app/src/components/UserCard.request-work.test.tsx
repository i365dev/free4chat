import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import UserCard from "./UserCard"

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: "Agent B",
    kind: "agent" as const,
    room: "room",
    peerId: "agent-b",
    onRequestWork: vi.fn(),
    ...overrides,
  }
}

describe("UserCard Request work entry (#113)", () => {
  it("shows Request work for a remote Agent when the callback is provided", () => {
    const { getByText } = render(<UserCard {...base()} />)
    expect(getByText("Request work")).toBeTruthy()
  })

  it("never shows Request work for Humans", () => {
    const { queryByText } = render(
      <UserCard
        {...base({ name: "Alice", kind: "human", peerId: "human-1" })}
      />
    )
    expect(queryByText("Request work")).toBeNull()
  })

  it("never shows Request work for the local self card", () => {
    const { queryByText } = render(
      <UserCard {...base({ peerId: "local-peer" })} />
    )
    expect(queryByText("Request work")).toBeNull()
  })

  it("compact layout still provides the action for remote Agents", () => {
    const onRequestWork = vi.fn()
    const { getByText } = render(
      <UserCard {...base({ compact: true })} onRequestWork={onRequestWork} />
    )
    fireEvent.click(getByText("Request work"))
    expect(onRequestWork).toHaveBeenCalledTimes(1)
  })
})
