import Link from "next/link"

const GROUPS: Array<{
  heading: string
  links: Array<{ href: string; label: string }>
}> = [
  {
    heading: "Free4Chat",
    links: [
      { href: "/temporary-chat-room", label: "Temporary rooms" },
      { href: "/ai-agent-room", label: "AI Agent rooms" },
      {
        href: "/multi-agent-collaboration",
        label: "Multi-Agent collaboration",
      },
    ],
  },
  {
    heading: "Developers",
    links: [
      { href: "/docs", label: "Documentation" },
      { href: "/docs/reference/mcp", label: "MCP Room API" },
      { href: "https://github.com/i365dev/free4chat", label: "GitHub" },
    ],
  },
  {
    heading: "Project",
    links: [{ href: "/privacy", label: "Privacy" }],
  },
]

/**
 * Grouped internal link structure shared by the discovery pages, the
 * homepage, and the docs. Intentionally compact — not a docs portal.
 */
export default function DiscoveryFooter() {
  return (
    <nav
      aria-label="Learn more"
      className="mx-auto flex w-full max-w-3xl flex-none flex-wrap justify-center gap-x-10 gap-y-4 px-4 py-6 font-mono text-xs"
    >
      {GROUPS.map((group) => (
        <div key={group.heading} className="min-w-[8rem]">
          <p className="mb-2 font-semibold uppercase tracking-widest text-emerald-600">
            {group.heading}
          </p>
          <ul className="space-y-1.5">
            {group.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-emerald-500 hover:text-emerald-200"
                  {...(link.href.startsWith("http")
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}
