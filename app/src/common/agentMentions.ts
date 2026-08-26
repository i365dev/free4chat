export interface AgentMentionCandidate {
  peerId: string
  name: string
}

export interface SelectedAgentMention {
  id: string
  name: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasCompleteMention(text: string, name: string): boolean {
  const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(name)}(?=$|\\s)`)
  return pattern.test(text)
}

export function resolveAgentTargetIds(
  text: string,
  connectedAgents: AgentMentionCandidate[],
  selectedAgents: SelectedAgentMention[],
): string[] {
  const targets = new Set<string>()
  const completeMentions = connectedAgents.filter((agent) =>
    hasCompleteMention(text, agent.name),
  )

  for (const selected of selectedAgents) {
    if (hasCompleteMention(text, selected.name)) targets.add(selected.id)
  }

  const mentionedNames = new Set(completeMentions.map((agent) => agent.name))
  for (const name of mentionedNames) {
    const matches = completeMentions.filter((agent) => agent.name === name)
    if (matches.length === 1) targets.add(matches[0].peerId)
  }

  return [...targets]
}
