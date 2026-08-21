// @ts-ignore generated at build time
import { default as handler } from "./.open-next/worker.js"

import { handleSfuRequest } from "./src/sfu/server"

export { RoomSession } from "./src/do/RoomSession"

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/api/sfu/")) {
      return handleSfuRequest(request, env)
    }
    return handler.fetch(request, env, ctx)
  },
}
