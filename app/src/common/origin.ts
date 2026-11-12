const ALLOWED_ORIGINS = new Set([
  "https://zchat.bfzone.ccwu.cc",
])

export function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && ALLOWED_ORIGINS.has(origin)
}
