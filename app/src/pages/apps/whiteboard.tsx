import { useRouter } from "next/router"

import {
  generateParticipantName,
  generateRoomName,
} from "../../common/cosmicNames"
import { saveRoomToLocalStorage } from "../../common/utils"
import DiscoveryPageLayout from "../../components/DiscoveryPageLayout"

export default function WhiteboardPage() {
  const router = useRouter()

  const openWhiteboardRoom = () => {
    const roomName = generateRoomName()
    const nickName = generateParticipantName()
    saveRoomToLocalStorage(roomName, nickName)
    void router.push(`/room?id=${encodeURIComponent(roomName)}&app=whiteboard`)
  }

  return (
    <DiscoveryPageLayout
      title="Free Online Collaborative Whiteboard — No Sign-Up | Free4Chat"
      description="Open a free online collaborative whiteboard in seconds. Draw and edit together in real time, share one Room link, and use it without an account or signup."
      path="/apps/whiteboard"
      ctaId="whiteboard"
      primaryCta={{
        label: "Open Whiteboard Room",
        onClick: openWhiteboardRoom,
      }}
      h1="A free collaborative whiteboard you can open and share instantly"
    >
      <p>
        Whiteboard is a free online whiteboard powered by Excalidraw, inside a
        temporary Free4Chat Room. No account or login is required. Open the
        board, share the Room link, and invited people enter the same Room with
        Whiteboard selected on the Stage.
      </p>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Open a Whiteboard Room.</strong> The board starts on the
          Room&apos;s Stage.
        </li>
        <li>
          <strong>Share the Room link.</strong> Invitees join the same Room with
          Whiteboard selected.
        </li>
        <li>
          <strong>Draw together.</strong> Add ideas and edit the shared scene in
          real time.
        </li>
      </ol>

      <h2>What you can do</h2>
      <ul>
        <li>
          Sketch freehand; add text, rectangles, ellipses, diamonds, arrows, and
          lines.
        </li>
        <li>
          Select, move, and edit objects, adjust drawing styles, and zoom or pan
          around the board.
        </li>
        <li>
          Draw with a mouse or trackpad, or use touch input on a phone or
          tablet.
        </li>
        <li>
          Collaborate with multiple people while keeping Room voice, text, and
          file sharing alongside the board.
        </li>
        <li>
          Use <strong>New board</strong> to clear the shared scene for everyone
          and start fresh.
        </li>
      </ul>

      <h2>Useful for quick shared thinking</h2>
      <p>
        Use a shared whiteboard for remote brainstorming, a quick team meeting,
        a visual explanation while teaching, or a temporary architecture or flow
        sketch. It gives people one place to shape an idea together without
        setting up a permanent workspace.
      </p>

      <h2>Temporary by design</h2>
      <p>
        No account is needed, and Whiteboard V1 does not save a permanent board.
        The scene lives in active browser replicas; if every replica disappears
        or reloads, the board may reset. Image and file import into the board is
        not supported in V1. Room file sharing remains available separately.
      </p>

      <h2>Whiteboard FAQ</h2>
      <h3>Is the online whiteboard free?</h3>
      <p>Yes. You can open and use the current Whiteboard App for free.</p>

      <h3>Do I need an account or login?</h3>
      <p>No account or login is required to start a Whiteboard Room.</p>

      <h3>Can multiple people draw on the same whiteboard?</h3>
      <p>
        Yes. People in the Room can draw and edit the shared board together in
        real time.
      </p>

      <h3>Can I use it on a phone or tablet?</h3>
      <p>
        Yes. The embedded drawing surface supports touch input, including on
        phones and tablets.
      </p>

      <h3>Is the whiteboard saved permanently?</h3>
      <p>
        No. Whiteboard V1 has no permanent board storage. The board may reset if
        every active browser replica reloads or disappears.
      </p>

      <h3>Can I import images or files into the board?</h3>
      <p>Not in V1. Room file sharing is available outside the board.</p>
    </DiscoveryPageLayout>
  )
}
