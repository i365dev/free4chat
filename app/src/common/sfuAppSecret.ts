/** Minimal shape of a Cloudflare Workers Secrets Store secret binding. */
export interface SfuAppSecretStore {
  get(): Promise<string>
}

export interface SfuAppSecretEnv {
  SFU_APP_SECRET?: string
  SFU_APP_SECRET_STORE?: SfuAppSecretStore
}

/**
 * Prefer the ordinary Worker secret to preserve existing deployments. The
 * Secrets Store fallback is used only when that binding is absent/empty. A
 * missing or unavailable secret is deliberately indistinguishable to callers
 * and fails closed without exposing provider errors or secret material.
 */
export async function resolveSfuAppSecret(
  env: SfuAppSecretEnv
): Promise<string | undefined> {
  if (env.SFU_APP_SECRET) return env.SFU_APP_SECRET
  if (!env.SFU_APP_SECRET_STORE) return undefined

  try {
    const secret = await env.SFU_APP_SECRET_STORE.get()
    return secret || undefined
  } catch {
    return undefined
  }
}
