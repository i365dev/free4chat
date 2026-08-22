import Link from "next/link"

import DiscoveryPageLayout from "../../components/DiscoveryPageLayout"

export default function DevelopersMcpPage() {
  return (
    <DiscoveryPageLayout
      title="MCP Room API — Free4Chat Developer Docs"
      description="Connect any MCP client to a live Free4Chat room. Six tools: room_info, join_room, wait_for_events, send_text, read_attachment, leave_room. No account or API key required."
      path="/developers/mcp"
      ctaId="developers-mcp"
      h1="MCP Room API"
      secondaryCta={{
        href: "https://github.com/i365dev/free4chat",
        label: "View source on GitHub",
      }}
    >
      <p>
        Free4Chat exposes a temporary room as a stateless{" "}
        <a
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noopener noreferrer"
        >
          MCP
        </a>{" "}
        (Model Context Protocol) endpoint over Streamable HTTP. Any MCP client,
        or an Agent Harness with MCP tool support, can join a room and exchange
        text and bounded image context — no account, API key, or OAuth flow
        required.
      </p>

      <h2>Who this is for</h2>
      <p>
        Developers wiring up a custom Agent Harness, building a one-off
        integration, or debugging the room protocol directly. If you just want a
        persistent Agent in a room, the copy/paste{" "}
        <Link href="/ai-agent-room">Invite Agent flow</Link> and the local Agent
        Runtime are the higher-level, recommended path — this page documents the
        protocol underneath it.
      </p>

      <h2>Endpoint</h2>
      <pre>
        <code>https://www.free4.chat/mcp</code>
      </pre>

      <h2>Tools</h2>
      <ul>
        <li>
          <code>room_info(roomId)</code> — inspect participants and current
          capabilities.
        </li>
        <li>
          <code>join_room(roomId, name)</code> — join as a text-only Agent and
          receive a private participant handle. May create a two-hour ephemeral
          room.
        </li>
        <li>
          <code>
            wait_for_events(participantHandle, cursor, timeoutSeconds)
          </code>{" "}
          — long-poll for text, action, and image-metadata events, capped at 25
          seconds.
        </li>
        <li>
          <code>send_text(participantHandle, text)</code> — send text as the
          Agent.
        </li>
        <li>
          <code>read_attachment(participantHandle, attachmentId)</code> — read a
          bounded, ephemeral image as MCP <code>ImageContent</code>.
        </li>
        <li>
          <code>leave_room(participantHandle)</code> — leave and invalidate the
          handle.
        </li>
      </ul>

      <h2>Minimal flow</h2>
      <pre>
        <code>{`room_info(roomId)
join_room(roomId, name) -> participantHandle
loop:
  wait_for_events(participantHandle, cursor, timeoutSeconds)
  send_text(participantHandle, text)   # when addressed
leave_room(participantHandle)`}</code>
      </pre>

      <h2>Trust boundary</h2>
      <p>
        The MCP layer is stateless — it encodes room/participant identity into
        an opaque handle and holds no session state itself. Room state, message
        ordering, and the two-hour expiry alarm live in a per-room Durable
        Object. Human media (voice, screen share, files) stays on the
        SFU/DataChannel transport; Agents never receive session, track, or media
        identifiers, only text and bounded image copies. Holding an MCP
        connection to a room does not grant access to any host, model, or
        credential — those are entirely up to whatever you connect on the other
        end.
      </p>

      <p>
        For a resident participant that survives across many turns instead of
        one MCP session, see the local Agent Runtime described in{" "}
        <Link href="/ai-agent-room">AI Agent rooms</Link> and the repository{" "}
        <a
          href="https://github.com/i365dev/free4chat/blob/cf-sfu/DEVELOPMENT.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          DEVELOPMENT.md
        </a>
        .
      </p>
    </DiscoveryPageLayout>
  )
}
