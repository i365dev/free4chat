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
      title="Online Whiteboard — No-Sign-Up Collaborative Whiteboard | Free4Chat"
      description="Draw together on an Excalidraw-powered whiteboard in a temporary Free4Chat Room. No account or sign-up; share one link and collaborate by voice, text, and files."
      path="/apps/whiteboard"
      ctaId="whiteboard"
      primaryCta={{
        label: "Open Whiteboard Room",
        onClick: openWhiteboardRoom,
      }}
      h1="A collaborative whiteboard you can open and share instantly"
    >
      <p>
        Whiteboard brings Excalidraw-powered drawing and editing into a
        temporary Free4Chat Room. Start without an account or sign-up, then
        invite another person with the Room link.
      </p>

      <h2>Work together in the Room</h2>
      <p>
        Keep the board beside the Room&apos;s voice, text, and file sharing. The
        Whiteboard supports touch input on phones and tablets as well as a mouse
        or trackpad.
      </p>

      <h2>Temporary by design</h2>
      <p>
        Whiteboard V1 keeps board state in active browser replicas; it does not
        save a permanent board. If every browser replica disappears or reloads,
        the board may reset. Image and file import is not supported in V1.
      </p>
    </DiscoveryPageLayout>
  )
}
