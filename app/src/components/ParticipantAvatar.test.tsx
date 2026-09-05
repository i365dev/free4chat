import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import ParticipantAvatar, {
  participantAccent,
  participantVariant,
} from "./ParticipantAvatar"

describe("ParticipantAvatar", () => {
  it("uses a deterministic local accent and shared avatar grammar", () => {
    const { container, getAllByTestId } = render(
      <>
        <ParticipantAvatar name="Hermes" kind="agent" />
        <ParticipantAvatar name="Hermes" kind="human" />
      </>
    )

    const avatars = getAllByTestId("participant-avatar")
    expect(avatars).toHaveLength(2)
    expect(avatars[0]).toHaveClass("participant-avatar")
    expect(avatars[1]).toHaveClass("participant-avatar")
    expect(avatars[0]).toHaveStyle({
      "--participant-accent": participantAccent("Hermes"),
    })
    expect(avatars[1]).toHaveStyle({
      "--participant-accent": participantAccent("Hermes"),
    })
    expect(avatars[0]).toHaveAttribute(
      "data-avatar-variant",
      participantVariant("Hermes")
    )
    expect(avatars[1]).toHaveAttribute(
      "data-avatar-variant",
      participantVariant("Hermes")
    )
    expect(container.querySelectorAll("img")).toHaveLength(0)
  })

  it("supports a compact node without a network avatar dependency", () => {
    const { getByTestId } = render(
      <ParticipantAvatar name="Pi" kind="agent" size="compact" />
    )
    expect(getByTestId("participant-avatar")).toHaveClass(
      "participant-avatar--compact"
    )
    expect(getByTestId("participant-avatar").querySelector("svg")).toBeTruthy()
  })
})
