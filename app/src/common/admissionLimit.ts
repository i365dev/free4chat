// #406: coarse pre-admission throttling for anonymous/cheap entry points.
//
// The Cloudflare Workers Rate Limiting binding is preferred: it is enforced
// per Cloudflare location, is intentionally NOT an exact global quota or an
// identity system, and — unlike the KV counter it replaces — costs no KV
// read/write per attempt, so a flood no longer amplifies storage cost.
//
// The KV branch is a fallback for environments that do not declare the
// binding (local unit tests, older harnesses). Production declares every
// limiter in wrangler.jsonc, so those paths never touch KV.
export interface AdmissionRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface AdmissionRateLimitOptions {
  limiter?: AdmissionRateLimiter
  kv?: KVNamespace
  /** Full counter key, including the caller/operation class prefix. */
  key: string
  /** KV-fallback budget only; the binding's own limit lives in wrangler.jsonc. */
  max: number
  windowSeconds: number
}

export async function allowAdmission(
  options: AdmissionRateLimitOptions
): Promise<boolean> {
  const { limiter, kv, key, max, windowSeconds } = options
  if (limiter) {
    try {
      const { success } = await limiter.limit({ key })
      // A successful binding check is authoritative: never also charge the KV
      // counter on the migrated path.
      return success
    } catch {
      // A limiter failure must not become an outage. Fall through to the KV
      // fallback when one is configured.
    }
  }
  if (!kv) return true
  const raw = await kv.get(key)
  const count = raw ? Number.parseInt(raw, 10) : 0
  if (count >= max) return false
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds })
  return true
}
