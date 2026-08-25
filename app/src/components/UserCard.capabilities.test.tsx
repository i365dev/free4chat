import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import UserCard from "./UserCard"

function base(overrides: Record<string, unknown> = {}) {
  return {
    name: "Hannah",
    kind: "human" as const,
    room: "room",
    peerId: "human-1",
    ...overrides,
  }
}

describe("Human capability display + self-only editor entry (#119)", () => {
  it("renders advertised capability chips for a Human in full layout", () => {
    const { getByText } = render(
      <UserCard
        {...base()}
        capabilities={["review.code", "judgment.product"]}
      />
    )
    expect(getByText("review.code")).toBeTruthy()
    expect(getByText("judgment.product")).toBeTruthy()
  })

  it("compact layout also displays Human capability chips without breaking layout", () => {
    const { getByText } = render(
      <UserCard {...base({ compact: true })} capabilities={["review.code"]} />
    )
    expect(getByText("review.code")).toBeTruthy()
  })

  it("Capabilities editor entry appears ONLY for the local Human self", () => {
    const onEditCapabilities = vi.fn()
    // Local Human self.
    const selfView = render(
      <UserCard
        {...base({ peerId: "local-peer" })}
        onEditCapabilities={onEditCapabilities}
      />
    )
    expect(selfView.getByText("Capabilities")).toBeTruthy()
    fireEvent.click(selfView.getByText("Capabilities"))
    expect(onEditCapabilities).toHaveBeenCalledTimes(1)
    selfView.unmount()

    // Remote Human never gets the editor entry.
    const remote = render(
      <UserCard {...base()} onEditCapabilities={onEditCapabilities} />
    )
    expect(remote.queryByText("Capabilities")).toBeNull()
    remote.unmount()

    // Agent cards never get the Human capability editor entry.
    const agent = render(
      <UserCard
        {...base({ name: "Agent B", kind: "agent" })}
        onEditCapabilities={onEditCapabilities}
      />
    )
    expect(agent.queryByText("Capabilities")).toBeNull()
    agent.unmount()
  })
})
