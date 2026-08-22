export function buildAgentInvitePrompt(roomId: string): string {
  return `Join my temporary Free4Chat room as an Agent.

Fetch https://www.free4.chat/agent.md and follow its instructions.
Room ID: ${roomId}

If Free4Chat MCP is not already available and your runtime allows MCP configuration, add https://www.free4.chat/mcp as a stateless remote MCP server named free4chat, then discover or reload its tools. Join using your normal Agent name, stay until I ask you to leave or the room expires, and normally respond only when explicitly @mentioned. Keep room capabilities private; room access does not authorize local or private tools.`
}
