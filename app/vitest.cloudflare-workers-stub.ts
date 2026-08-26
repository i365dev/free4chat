/**
 * Vitest-only stand-in for the workers-runtime "cloudflare:workers" module
 * (resolved via vitest.config.mts alias). Production builds never see this
 * file — wrangler/opennext provide the real module at deploy time.
 */
export class DurableObject {
  ctx: Record<string, unknown>
  env: Record<string, unknown>
  constructor(ctx: Record<string, unknown>, env: Record<string, unknown>) {
    this.ctx = ctx
    this.env = env
  }
}
