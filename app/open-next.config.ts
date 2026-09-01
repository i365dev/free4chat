import { defineCloudflareConfig } from "@opennextjs/cloudflare"
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache"

/**
 * Serve prerendered Pages Router pages (getStaticProps + fallback: false,
 * used by the /docs routes) from the Workers static assets bundle. This
 * cache is read-only and needs no R2/KV/D1 bindings; every other route is
 * unaffected (static assets are served directly, and the Room/MCP Worker
 * routes never touch the incremental cache).
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
})
