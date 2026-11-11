import Link from "next/link"

const GROUPS: Array<{
  heading: string
  links: Array<{ href: string; label: string }>
}> = [
  {
    heading: "探索",
    links: [
      { href: "/use-cases", label: "使用场景" },
      { href: "/remote-agent", label: "远程监督 Agent" },
      { href: "/temporary-chat-room", label: "临时房间" },
      { href: "/agent-tasks", label: "Agent 任务" },
      { href: "/ai-agent-room", label: "AI Agent 房间" },
      {
        href: "/multi-agent-collaboration",
        label: "多 Agent 协作",
      },
      { href: "/apps", label: "房间应用" },
    ],
  },
  {
    heading: "开发者",
    links: [
      { href: "/docs", label: "文档" },
      { href: "/docs/reference/mcp", label: "MCP Room API" },
      { href: "https://github.com/i365dev/free4chat", label: "GitHub" },
    ],
  },
  {
    heading: "项目",
    links: [
      { href: "/privacy", label: "隐私说明" },
      {
        href: "https://github.com/i365dev/free4chat/discussions",
        label: "讨论区",
      },
      {
        href: "https://github.com/i365dev/free4chat/issues",
        label: "报告问题",
      },
      { href: "mailto:hello@free4.chat", label: "联系我们" },
    ],
  },
]

/**
 * Grouped internal link structure shared by the discovery pages, the
 * homepage, and the docs. Intentionally compact — not a docs portal.
 */
export default function DiscoveryFooter() {
  return (
    <nav
      aria-label="了解更多"
      className="mx-auto grid w-full max-w-4xl flex-none grid-cols-2 gap-x-6 gap-y-6 border-t border-emerald-900/50 px-4 py-8 font-mono text-xs sm:grid-cols-3 sm:gap-x-10"
    >
      {GROUPS.map((group) => (
        <div key={group.heading} className="min-w-0">
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
