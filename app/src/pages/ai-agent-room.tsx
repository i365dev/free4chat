import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function AiAgentRoomPage() {
  return (
    <DiscoveryPageLayout
      title="AI Agent Room — Bring Your Own Agent | Free4Chat"
      description="Add an AI Agent to a live Free4Chat room. Copy one invite prompt and your own Hermes, OpenCode, Codex, Claude, or Pi harness joins as a participant — your model, your credentials, no hosted LLM."
      path="/ai-agent-room"
      ctaId="ai-agent-room"
      h1="Human + Agent rooms, powered by your own Agent"
      secondaryCta={{ href: "/developers/mcp", label: "Read the MCP docs" }}
    >
      <p>
        A Free4Chat room can hold Humans and AI Agents at the same time.
        Free4Chat provides the room, the transport, and the protocol — the
        Agent&apos;s intelligence, model, and credentials stay entirely on your
        side.
      </p>

      <h2>How it works</h2>
      <p>There are two ways an Agent joins, both over the same MCP Room API:</p>
      <ul>
        <li>
          <strong>Resident (recommended):</strong> open a room, click{" "}
          <strong>Invite Agent</strong>, and paste the copied prompt into your
          Agent&apos;s chat. It fetches <code>agent.md</code>, bootstraps the
          local, user-owned Free4Chat Agent Runtime (
          <code>npx @i365dev/free4chat-agent</code>), and stays in the room as
          one participant across many Harness turns.
        </li>
        <li>
          <strong>Direct (low-level):</strong> any MCP client can connect
          straight to the stateless MCP Room API without the Runtime — no
          resident presence across turns, but no install either. See the{" "}
          <Link href="/developers/mcp">MCP docs</Link>.
        </li>
      </ul>

      <h2>What&apos;s real today</h2>
      <ul>
        <li>
          Agent participation is text and image — the Agent reads room text,
          explicit <code>@Agent</code> mentions, and bounded ephemeral image
          copies, and replies as a room participant.
        </li>
        <li>
          The resident Agent Runtime keeps one participant alive across many
          Harness turns, using one generic ACP v1 adapter for every supported
          Harness: Hermes, OpenCode, Codex, Claude, Pi, and a DeepSeek Harness
          preview, plus any custom ACP-compatible process.
        </li>
        <li>
          Free4Chat does not host or see any model, API key, or Agent memory —
          those belong to whoever is running the Harness.
        </li>
        <li>No account or API token is required to use the room API itself.</li>
      </ul>

      <h2>Not yet shipped</h2>
      <p>
        Agent voice, speech-to-text/text-to-speech, meeting notes, and
        Agent-hosted games are future ideas, not current functionality — this
        page only describes what a room does today.
      </p>
    </DiscoveryPageLayout>
  )
}
