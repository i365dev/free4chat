import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function TemporaryChatRoomPage() {
  return (
    <DiscoveryPageLayout
      title="Temporary Chat Room — No Sign-Up, No History | Free4Chat"
      description="Open an instant temporary room for voice, text, and screen sharing. No account, no persistent history — rooms close automatically once everyone has left."
      path="/temporary-chat-room"
      ctaId="temporary-chat-room"
      h1="A temporary room for voice, text, and screen sharing"
    >
      <p>
        Free4Chat rooms exist to have one conversation and then disappear. There
        is no account to create and nothing to install, and the room itself
        leaves no permanent history on our servers once it closes.
      </p>

      <h2>What you get</h2>
      <ul>
        <li>Voice chat, right in the browser.</li>
        <li>Text chat with emoji reactions.</li>
        <li>
          File and image transfer, sent directly between participants over a
          WebRTC data channel.
        </li>
        <li>Screen sharing (desktop browsers).</li>
      </ul>

      <h2>What makes it temporary</h2>
      <ul>
        <li>No sign-up, no account, no identity to manage.</li>
        <li>
          Free4Chat keeps no permanent room history on our servers — a
          room&apos;s presence, messages, and expiry state live only while the
          room is active.
        </li>
        <li>
          A room isn&apos;t on a fixed timer — it stays open as long as
          someone&apos;s in it, and closes automatically a while after everyone
          has left.
        </li>
        <li>
          Sharing is just a link: open a room, copy the URL, send it to whoever
          should join.
        </li>
      </ul>

      <h2>What this isn&apos;t</h2>
      <p>
        Free4Chat is not an end-to-end encrypted messenger. Voice and screen
        sharing are relayed through Cloudflare&apos;s media network so multiple
        participants can hear and see each other; that network sees the media in
        transit. Files and images between Humans travel browser-to-browser over
        a data channel and are not stored as Free4Chat server files. A bounded,
        temporary Agent-readable Room copy may exist when a Human shares an
        image with a connected Agent; explicit Agent image and text-like
        artifacts are a separate bounded Room feature. Your room name and
        nickname are also saved in your browser&apos;s <code>localStorage</code>{" "}
        until you clear it. See <Link href="/privacy">Privacy</Link> for the
        full picture.
      </p>

      <p>
        Want an AI Agent in the room instead of, or alongside, another human?
        See <Link href="/ai-agent-room">AI Agent rooms</Link>.
      </p>
    </DiscoveryPageLayout>
  )
}
