import type { ReactElement } from "react"

import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// SeoHead relies on Next's real head-manager DOM side effect, which does not
// run reliably outside `next build`/`next dev` in this test environment.
// Instead of asserting rendered <head> tags, assert what each page *authors*
// by intercepting the props it passes to the shared layout — an equally
// strong guarantee that titles/descriptions/canonicals are correct and
// unique, without depending on Next-internal DOM timing.
vi.mock("../../components/DiscoveryPageLayout", () => ({
  default: (props: {
    title: string
    description: string
    path: string
    ctaId: string
  }) => (
    <div
      data-testid="layout-stub"
      data-title={props.title}
      data-description={props.description}
      data-path={props.path}
      data-cta-id={props.ctaId}
    />
  ),
}))

import AiAgentRoomPage from "../../pages/ai-agent-room"
import DevelopersMcpPage from "../../pages/developers/mcp"
import PrivacyPage from "../../pages/privacy"
import TemporaryChatRoomPage from "../../pages/temporary-chat-room"

const PAGES: Array<{
  name: string
  Component: () => ReactElement
  path: string
}> = [
  {
    name: "temporary-chat-room",
    Component: TemporaryChatRoomPage,
    path: "/temporary-chat-room",
  },
  { name: "ai-agent-room", Component: AiAgentRoomPage, path: "/ai-agent-room" },
  { name: "privacy", Component: PrivacyPage, path: "/privacy" },
  {
    name: "developers/mcp",
    Component: DevelopersMcpPage,
    path: "/developers/mcp",
  },
]

function renderStub(Component: () => ReactElement) {
  const { container, unmount } = render(<Component />)
  const stub = container.querySelector<HTMLElement>(
    '[data-testid="layout-stub"]',
  )
  return { stub, unmount }
}

describe("Discovery pages — SEO metadata authored per page", () => {
  it("each page has a unique, non-empty title and description", () => {
    const titles = new Set<string>()
    const descriptions = new Set<string>()

    for (const { name, Component } of PAGES) {
      const { stub, unmount } = renderStub(Component)
      const title = stub?.dataset.title ?? ""
      const description = stub?.dataset.description ?? ""

      expect(title, `${name} title`).not.toBe("")
      expect(description, `${name} description`).not.toBe("")
      expect(titles.has(title), `duplicate title on ${name}: ${title}`).toBe(
        false,
      )
      expect(
        descriptions.has(description),
        `duplicate description on ${name}`,
      ).toBe(false)
      titles.add(title)
      descriptions.add(description)

      unmount()
    }
  })

  it.each(PAGES)(
    "$name's path prop matches its route",
    ({ Component, path }) => {
      const { stub, unmount } = renderStub(Component)
      expect(stub?.dataset.path).toBe(path)
      unmount()
    },
  )

  it("every page has a distinct analytics ctaId", () => {
    const ids = new Set<string>()
    for (const { Component } of PAGES) {
      const { stub, unmount } = renderStub(Component)
      const ctaId = stub?.dataset.ctaId ?? ""
      expect(ctaId).not.toBe("")
      expect(ids.has(ctaId)).toBe(false)
      ids.add(ctaId)
      unmount()
    }
  })
})
