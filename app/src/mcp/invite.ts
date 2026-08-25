// #51 portable room-invite descriptor v1. Deliberately tiny public data:
// identity of the room plus a Human-convenience URL. Never carries participant
// handles, tokens, creator credentials, Harness identity, capability
// credentials, or task instructions — it is safe to paste into any existing
// channel. The canonical MCP endpoint/bootstrap stays hard-coded in
// app/public/agent.md; roomUrl must never redirect an Agent.
export interface RoomInviteDescriptorV1 {
  kind: "free4chat.room-invite"
  version: 1
  roomId: string
  roomUrl: string
}

export const ROOM_INVITE_KIND = "free4chat.room-invite" as const

/** Builds the public half of a create_room result. The private participant
 * handle/token never passes through here — callers keep those separate. */
export function buildRoomInvite(roomId: string): RoomInviteDescriptorV1 {
  return {
    kind: ROOM_INVITE_KIND,
    version: 1,
    roomId,
    roomUrl: `https://www.free4.chat/room?id=${encodeURIComponent(roomId)}`,
  }
}
