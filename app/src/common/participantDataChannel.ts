/**
 * Stable label for a reliable participant-pair channel. The label is an
 * address only: Core must authorize the authenticated participant pair and
 * current Room/App association before asking the SFU to create a subscription.
 */
export function participantDirectReliableChannelName(
  agentParticipantId: string,
  humanParticipantId: string
): string | null {
  const validParticipantId = (value: string) =>
    /^[A-Za-z0-9_-]{1,128}$/.test(value)
  if (
    !validParticipantId(agentParticipantId) ||
    !validParticipantId(humanParticipantId) ||
    agentParticipantId === humanParticipantId
  )
    return null
  return `participant-direct-reliable-${agentParticipantId.length}-${agentParticipantId}-${humanParticipantId}`
}

/** Validates the pair label's publisher address while leaving subscriber
 * authorization to RoomSession, which binds the Human suffix to membership
 * and the current Generated App route. */
export function isParticipantDirectReliableChannelForAgent(
  name: string,
  agentParticipantId: string
): boolean {
  const validParticipantId = (value: string) =>
    /^[A-Za-z0-9_-]{1,128}$/.test(value)
  if (!validParticipantId(agentParticipantId)) return false
  const prefix = `participant-direct-reliable-${agentParticipantId.length}-${agentParticipantId}-`
  if (!name.startsWith(prefix)) return false
  const humanParticipantId = name.slice(prefix.length)
  return (
    validParticipantId(humanParticipantId) &&
    humanParticipantId !== agentParticipantId &&
    participantDirectReliableChannelName(
      agentParticipantId,
      humanParticipantId
    ) === name
  )
}
