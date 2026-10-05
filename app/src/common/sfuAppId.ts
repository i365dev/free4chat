export interface SfuAppIdStore {
  get(): Promise<string>
}

export interface SfuAppIdEnv {
  SFU_APP_ID?: string
  SFU_APP_ID_STORE?: SfuAppIdStore
}

/** Prefer the existing Worker variable, with a fail-closed Secrets Store fallback. */
export async function resolveSfuAppId(
  env: SfuAppIdEnv
): Promise<string | undefined> {
  if (env.SFU_APP_ID) return env.SFU_APP_ID
  if (!env.SFU_APP_ID_STORE) return undefined

  try {
    const appId = await env.SFU_APP_ID_STORE.get()
    return appId || undefined
  } catch {
    return undefined
  }
}
