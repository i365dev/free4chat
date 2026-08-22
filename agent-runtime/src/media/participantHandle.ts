/**
 * Mirrors app/src/mcp/server.ts's encodeHandle/decodeHandle exactly (same
 * base64url(JSON) encoding). The Runtime already holds this handle from its
 * normal MCP join_room call — MediaBridge decodes it locally to reach the
 * plain REST agent-media endpoints directly, without a second credential
 * and without ever handing the token to the Harness.
 */
export interface DecodedParticipantHandle {
  room: string
  participantId: string
  participantToken: string
}

export function decodeParticipantHandle(
  handle: string
): DecodedParticipantHandle {
  const padded = handle.replaceAll("-", "+").replaceAll("_", "/")
  const binary = Buffer.from(
    padded + "=".repeat((4 - (padded.length % 4)) % 4),
    "base64"
  ).toString("binary")
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const candidate = JSON.parse(
    new TextDecoder().decode(bytes)
  ) as Partial<DecodedParticipantHandle>
  if (
    typeof candidate.room !== "string" ||
    typeof candidate.participantId !== "string" ||
    typeof candidate.participantToken !== "string" ||
    !candidate.room ||
    !candidate.participantId ||
    !candidate.participantToken
  ) {
    throw new Error("invalid_participant_handle")
  }
  return {
    room: candidate.room,
    participantId: candidate.participantId,
    participantToken: candidate.participantToken,
  }
}
