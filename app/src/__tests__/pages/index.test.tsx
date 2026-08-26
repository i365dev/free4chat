import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import Home from "../../pages/index"

describe("Home page", () => {
  it("renders real product content immediately, with no Turnstile challenge blocking the view", () => {
    render(<Home />)

    expect(
      screen.getByRole("heading", { name: /open a room\. talk instantly\./i }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /join/i })).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Room Name")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Nick Name")).toBeInTheDocument()

    // The old global gate rendered this instead of the page. It must be gone.
    expect(
      screen.queryByText(/verifying you.re human/i),
    ).not.toBeInTheDocument()
  })
})
