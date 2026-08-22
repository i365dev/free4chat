import Link from "next/link"

const LINKS = [
  { href: "/temporary-chat-room", label: "Temporary rooms" },
  { href: "/ai-agent-room", label: "AI Agent rooms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/developers/mcp", label: "Developer integration" },
  { href: "https://github.com/i365dev/free4chat", label: "GitHub" },
]

/**
 * Minimal internal link group so the discovery pages (and the homepage) are
 * not SEO-orphaned. Intentionally not a navbar/docs portal.
 */
export default function DiscoveryFooter() {
  return (
    <nav
      aria-label="Learn more"
      className="mx-auto flex max-w-3xl flex-none flex-wrap justify-center gap-x-4 gap-y-2 px-4 py-4 text-xs text-gray-500"
    >
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="hover:text-gray-300"
          {...(link.href.startsWith("http")
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  )
}
