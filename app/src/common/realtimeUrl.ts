/**
 * Single source of truth for the Cloudflare Realtime base URL.
 *
 * #275: the local Room E2E harness overrides this base with a loopback fake
 * so that ALL Worker outbound Cloudflare Realtime I/O — both the SFU HTTP
 * routes (src/sfu/server.ts realtimeRequest) and the Durable Object media
 * cleanup effects (src/do/mediaEffects.ts executeMediaCloseEffect) — can
 * never reach the real rtc.live.cloudflare.com host on a test run.
 *
 * Production behavior (no SFU_RTC_BASE_URL) is byte-identical:
 * `https://rtc.live.cloudflare.com/v1/apps/{appId}`.
 */
export function realtimeBaseUrl(env: {
  SFU_APP_ID?: string
  SFU_RTC_BASE_URL?: string
}): string | null {
  if (env.SFU_RTC_BASE_URL) return env.SFU_RTC_BASE_URL
  if (!env.SFU_APP_ID) return null
  return `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(
    env.SFU_APP_ID
  )}`
}
