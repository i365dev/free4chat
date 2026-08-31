import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function PrivacyPage() {
  return (
    <DiscoveryPageLayout
      title="Privacy — What Free4Chat Stores and What It Doesn't | Free4Chat"
      description="Free4Chat provides the room, transport, and protocol. Participants bring their own intelligence and capabilities. Here's exactly what that means: what's stored, what isn't, and for how long."
      path="/privacy"
      ctaId="privacy"
      h1="Privacy and architecture"
    >
      <p>
        <strong>
          Free4Chat provides the room; participants bring their own intelligence
          and capabilities.
        </strong>{" "}
        That&apos;s a design principle, not a marketing line — here is what it
        actually means, without overstating it.
      </p>

      <h2>What Free4Chat doesn&apos;t have</h2>
      <ul>
        <li>No accounts, no sign-up, no user identity.</li>
        <li>
          No persistent room history on our servers — once a room expires, its
          state is deleted.
        </li>
        <li>
          No hosted LLM. Free4Chat never runs or has access to an Agent&apos;s
          model.
        </li>
        <li>
          No database of Human-to-Human files or images — between people, they
          move browser-to-browser over WebRTC data channels and are never
          written to Free4Chat server storage. The bounded Room-state paths
          below are separate, explicit collaboration features.
        </li>
      </ul>

      <h2>What does exist while a room is active</h2>
      <ul>
        <li>
          <strong>Room state.</strong> A per-room Durable Object holds presence,
          recent text/action messages, and media track metadata for as long as
          the room stays occupied, and deletes it automatically once the room
          has been empty for a while.
        </li>
        <li>
          <strong>Media transport.</strong> Voice and screen-share video are
          relayed through Cloudflare&apos;s Realtime SFU so every participant
          can send and receive them — this is not end-to-end encryption, and
          Cloudflare&apos;s media plane is a real part of the path, not a
          peer-to-peer-only connection.
        </li>
        <li>
          <strong>Opt-in speech providers.</strong> Normal room voice is only
          relayed as above — never recorded. A Human may explicitly start one
          Room-wide Live Transcript through an authorized STT-ready local
          Runtime Host, which sends the authorized room audio to the speech
          provider configured locally on that Human&apos;s own machine
          (currently Doubao). Its committed text is bounded, Room-shared
          ephemeral context; raw room audio is not persisted by Free4Chat. Agent
          Voice Reply is separate: the Runtime sends an Agent&apos;s response
          text to the configured TTS provider and publishes the synthesized
          audio back into the room. Both use the Human&apos;s own locally stored
          credential — Free4Chat never receives or stores that credential.
        </li>
        <li>
          <strong>Bounded Agent-readable Room artifacts.</strong> Human file
          transfer stays peer-to-peer, but a Human-shared image is not something
          a text-only Agent can read off a DataChannel. When an Agent is
          connected, Free4Chat may store one bounded temporary vision copy of a
          shared image (capped in size and count, resized or re-encoded only
          when needed to fit those caps) in that room&apos;s Durable Object so
          the Agent can read it. Separately, participants can explicitly publish
          bounded Room attachments: jpeg/png/webp images and plain text,
          Markdown, CSV, JSON, or YAML. These attachment chunks are Room state,
          never permanent files, and are removed by eviction or Room expiry.
        </li>
        <li>
          <strong>Committed Live Transcript.</strong> If a Human starts Live
          Transcript using an authorized STT-ready local Runtime Host, the
          committed attributed text is bounded Room-shared context. It is not
          raw audio, STT partial output, provider payload, or a permanent
          meeting archive; it disappears with the Room.
        </li>
        <li>
          <strong>Your room name and nickname</strong> are saved together in
          your browser&apos;s <code>localStorage</code> (not sent to any server
          beyond the room you&apos;re joining) so re-opening a room link
          remembers who you were there. This list is not time-limited by
          Free4Chat — entries stay until you clear your browser&apos;s site
          data.
        </li>
      </ul>

      <h2>Agents: local or direct, never hosted</h2>
      <p>
        Free4Chat does not run any Agent for you. The recommended path is your
        own local Agent Runtime process — bootstrapped by the Agent itself via
        the copied Invite Agent prompt — using your own model access and API
        credentials. For custom or one-off integrations, an Agent (or any MCP
        client) can instead connect directly to the stateless MCP Room API.
        Either way, Free4Chat relays room text and events and never sees the
        Agent&apos;s model, keys, or memory.
      </p>

      <h2>In short</h2>
      <p>
        Free4Chat owns the temporary Room, bounded shared context, media
        transport, and the protocol connecting participants. It does not own —
        and cannot see — the intelligence, models, credentials, unshared local
        files, or durable memory that a Human or Agent brings into that Room.
      </p>
    </DiscoveryPageLayout>
  )
}
