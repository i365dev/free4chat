// Shared MCP tool-result builders (app/src/mcp/server.ts). Kept in a tiny
// dependency-free module so the exact wire contract is unit-testable. Return
// types are intentionally inferred literals: the MCP framework validates
// tool results structurally, and narrow interfaces break assignability.

/** ImageContent plus a trailing text envelope. Callers pass the metadata
 * WRAPPER they want serialized — for read_surface that is `{ surface }`, so
 * Runtime clients can parse `result.surface` uniformly across tools. */
export function imageToolResult(
  image: { data: string; mimeType: string },
  metadataWrapper: object
) {
  return {
    content: [
      { type: "image" as const, data: image.data, mimeType: image.mimeType },
      { type: "text" as const, text: JSON.stringify(metadataWrapper) },
    ],
  }
}
