// @ts-ignore generated at build time
import { default as handler } from "./.open-next/worker.js"

import { handleScheduled } from "./src/do/ScheduledHandler"

export { BotSession } from "./src/do/BotSession"

export default {
  fetch: handler.fetch,
  scheduled: handleScheduled,
}
