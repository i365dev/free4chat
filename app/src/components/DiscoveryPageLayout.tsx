import type { ReactNode } from "react"

import Link from "next/link"

import DiscoveryFooter from "./DiscoveryFooter"
import SeoHead from "./SeoHead"
import { trackAnalyticsEvent } from "../common/utils"

export interface DiscoveryPageLayoutProps {
  /** <title> and og:title. */
  title: string
  /** meta description and og:description. */
  description: string
  /** Site-relative path, e.g. "/temporary-chat-room". */
  path: string
  /** Bounded page identifier sent with the CTA click event — never room/user data. */
  ctaId: string
  h1: string
  children: ReactNode
  /** Optional extra link shown next to the primary "Open a room" CTA. */
  secondaryCta?: {
    href: string
    label: string
    /** Small, static destination bucket — never a URL or user-provided value. */
    analyticsTarget: "mcp-docs" | "bring-agent" | "github"
  }
}

export default function DiscoveryPageLayout({
  title,
  description,
  path,
  ctaId,
  h1,
  children,
  secondaryCta,
}: DiscoveryPageLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-gray-900 text-white">
      <SeoHead title={title} description={description} path={path} />
      <main className="flex-1 px-4 py-16">
        <div className="mx-auto max-w-3xl">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← Free4Chat
          </Link>
          <h1 className="mt-4 text-3xl font-extrabold sm:text-4xl">{h1}</h1>
          <div className="prose prose-invert mt-6 max-w-none text-gray-300 prose-headings:text-white prose-a:text-blue-400 prose-strong:text-white">
            {children}
          </div>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/"
              onClick={() =>
                trackAnalyticsEvent("DiscoveryCtaClicked", { page: ctaId })
              }
              className="group flex items-center justify-center rounded-md bg-rose-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-rose-500 focus:outline-none focus:ring focus:ring-yellow-400"
            >
              Open a room
            </Link>
            {secondaryCta && (
              <Link
                href={secondaryCta.href}
                onClick={() =>
                  trackAnalyticsEvent("DiscoverySecondaryCtaClicked", {
                    page: ctaId,
                    target: secondaryCta.analyticsTarget,
                  })
                }
                className="text-sm text-gray-400 underline-offset-2 hover:text-gray-200 hover:underline"
              >
                {secondaryCta.label}
              </Link>
            )}
          </div>
        </div>
      </main>
      <DiscoveryFooter />
    </div>
  )
}
