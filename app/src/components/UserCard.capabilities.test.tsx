import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

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

describe("Agent advertised capabilities (#234)", () => {
  it("keeps advertised capabilities out of the default full card UI", () => {
    const { queryByText } = render(
      <UserCard
        {...base({ name: "Pi", kind: "agent", peerId: "agent-pi" })}
        capabilities={["code.edit", "shell"]}
      />
    )
    expect(queryByText("code.edit")).toBeNull()
    expect(queryByText("shell")).toBeNull()
  })

  it("keeps advertised capabilities out of the compact card UI", () => {
    const { queryByText } = render(
      <UserCard
        {...base({
          name: "Pi",
          kind: "agent",
          peerId: "agent-pi",
          compact: true,
        })}
        capabilities={["code.edit"]}
      />
    )
    expect(queryByText("code.edit")).toBeNull()
  })

  it("never shows a Human capability editor entry (removed with #234)", () => {
    const selfView = render(
      <UserCard {...base({ peerId: "local-peer" })} capabilities={[]} />
    )
    expect(selfView.queryByText("Capabilities")).toBeNull()
    selfView.unmount()

    const remote = render(<UserCard {...base()} capabilities={[]} />)
    expect(remote.queryByText("Capabilities")).toBeNull()
    remote.unmount()
  })

  it("never shows Request work on any card (removed with #234)", () => {
    const agent = render(
      <UserCard
        {...base({ name: "Pi", kind: "agent", peerId: "agent-pi" })}
        capabilities={["code.edit"]}
      />
    )
    expect(agent.queryByText("Request work")).toBeNull()
    agent.unmount()

    const compactAgent = render(
      <UserCard
        {...base({
          name: "Pi",
          kind: "agent",
          peerId: "agent-pi",
          compact: true,
        })}
        capabilities={["code.edit"]}
      />
    )
    expect(compactAgent.queryByText("Request work")).toBeNull()
    compactAgent.unmount()
  })
})
