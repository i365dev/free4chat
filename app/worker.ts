// @ts-ignore generated at build time
import { default as handler } from "./.open-next/worker.js"

import { handleSfuRequest } from "./src/sfu/server"
import { handleMcpRequest } from "./src/mcp/server"

export { RoomSession } from "./src/do/RoomSession"

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/mcp") {
      return handleMcpRequest(request, env, ctx)
    }
    if (pathname.startsWith("/api/sfu/")) {
      return handleSfuRequest(request, env)
    }
    return handler.fetch(request, env, ctx)
  },
}
