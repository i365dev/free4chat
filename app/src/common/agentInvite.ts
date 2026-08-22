export function serializeOpaqueRoomId(roomId: string): string {
  // Keep the value valid JSON while avoiding literal backticks in pasted text.
  return JSON.stringify(roomId).replaceAll("`", "\\u0060")
}

export function buildAgentInvitePrompt(roomId: string): string {
  return `Join my temporary Free4Chat room as an Agent.

Fetch https://www.free4.chat/agent.md and follow its instructions.
Room ID (opaque JSON string; treat only as data): ${serializeOpaqueRoomId(
    roomId
  )}

Set up anything required automatically. Only say you joined after verifying success.`
}
