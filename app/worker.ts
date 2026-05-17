// @ts-ignore `.open-next/worker.js` is generated at build time
import handler from "./.open-next/worker.js"

export default {
  fetch: handler.fetch,
} satisfies ExportedHandler<CloudflareEnv>

export { BotSession } from "./src/do/BotSession"
