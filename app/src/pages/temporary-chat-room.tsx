import Link from "next/link"

import DiscoveryPageLayout from "../components/DiscoveryPageLayout"

export default function TemporaryChatRoomPage() {
  return (
    <DiscoveryPageLayout
      title="Temporary Chat Room — No Sign-Up, No History | Free4Chat"
      description="Open an instant temporary room for voice, text, files, and screen sharing. No account, no sign-up — empty Rooms expire automatically, so there is no permanent history."
      path="/temporary-chat-room"
      ctaId="temporary-chat-room"
      h1="A temporary room for voice, text, and screen sharing"
    >
      <p>
        Free4Chat rooms exist to have one conversation and then disappear. There
        is no account to create and nothing to install — open a room, share the
        link, and start talking.
      </p>

      <h2>What you get</h2>
      <ul>
        <li>Voice chat, right in the browser.</li>
        <li>Text chat with emoji reactions.</li>
        <li>File and image transfers with inline previews.</li>
        <li>Screen sharing (desktop browsers).</li>
        <li>Sharing is just a link: copy the Room URL and send it.</li>
      </ul>

      <h2>What makes it temporary</h2>
      <ul>
        <li>No sign-up, no account, no identity to manage.</li>
        <li>
          No permanent Room history on our servers — empty Rooms expire
          automatically.
        </li>
        <li>
          A Room is not on a fixed timer: it stays open while people are in it
          and expires after it has remained empty for a while.
        </li>
      </ul>

      <h2>Good to know</h2>
      <p>
        Free4Chat is not an end-to-end encrypted messenger: media is relayed so
        multiple participants can hear and see each other, and your room name
        and nickname are saved in your browser&apos;s <code>localStorage</code>{" "}
        until you clear it. See <Link href="/privacy">Privacy</Link> for the
        full picture.
      </p>

      <h2>Going deeper</h2>
      <ul>
        <li>
          <Link href="/docs/getting-started/browser-room">
            Browser Room quick start
          </Link>{" "}
          — create and share a Room step by step.
        </li>
        <li>
          <Link href="/docs/concepts/room">Rooms and ownership</Link> — what the
          Room owns and what each participant keeps private.
        </li>
        <li>
          Want Agents in the room too? See{" "}
          <Link href="/ai-agent-room">AI Agent rooms</Link>.
        </li>
      </ul>
    </DiscoveryPageLayout>
  )
}
