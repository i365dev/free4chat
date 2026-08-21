import { useState } from "react"

import { useRealtimeKitChatRoom } from "./useRealtimeKitChatRoom"
import { useSfuChatRoom } from "./useSfuChatRoom"

export function useChatRoom(
  roomName: string,
  nickName: string,
  roomType: "audio" | "screenshare",
  enableBot?: boolean
) {
  const [useSfu] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("transport") !== "rtk"
  )
  const realtimeKitRoom = useRealtimeKitChatRoom(
    roomName,
    nickName,
    roomType,
    enableBot,
    !useSfu
  )
  const sfuRoom = useSfuChatRoom(
    roomName,
    nickName,
    roomType,
    enableBot,
    useSfu
  )
  return useSfu ? sfuRoom : realtimeKitRoom
}
