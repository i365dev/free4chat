import { render, screen } from "@testing-library/react"

import Home from "../src/pages/index"

describe("Home", () => {
  it("cta opens github", () => {
    render(<Home />)

    expect(screen.getByText("Copy Template from GitHub")).toHaveAttribute(
      "href",
      "https://github.com/agcty/nextjs-advanced-starter"
    )
  })
})
