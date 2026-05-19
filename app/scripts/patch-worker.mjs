import { execSync } from "child_process"
import { appendFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

const doSrc = resolve(root, "src/do/BotSession.ts")
const doOut = resolve(root, ".open-next/do-bot-session.js")
const schedulerSrc = resolve(root, "src/do/ScheduledHandler.ts")
const schedulerOut = resolve(root, ".open-next/do-scheduler.js")
const workerJs = resolve(root, ".open-next/worker.js")

if (!existsSync(doSrc)) {
  console.error("patch-worker: BotSession.ts not found, skipping")
  process.exit(0)
}

if (!existsSync(workerJs)) {
  console.error(
    "patch-worker: .open-next/worker.js not found — run cf-build first"
  )
  process.exit(1)
}

console.log("patch-worker: bundling BotSession...")
execSync(
  `npx esbuild "${doSrc}" --bundle --format=esm --platform=browser --outfile="${doOut}"`,
  { stdio: "inherit" }
)

console.log("patch-worker: patching worker.js with BotSession...")
appendFileSync(
  workerJs,
  `\n// --- BotSession DO (patched) ---\nexport { BotSession } from "./do-bot-session.js";\n`
)

console.log("patch-worker: bundling ScheduledHandler...")
execSync(
  `npx esbuild "${schedulerSrc}" --bundle --format=esm --platform=browser --outfile="${schedulerOut}"`,
  { stdio: "inherit" }
)

console.log("patch-worker: patching worker.js with scheduled handler...")
appendFileSync(
  workerJs,
  `\n// --- ScheduledHandler (patched) ---
import { handleScheduled as __handleScheduled } from "./do-scheduler.js";
export default {
  fetch: _worker.fetch,
  scheduled: __handleScheduled,
};\n`
)

console.log("patch-worker: done")
