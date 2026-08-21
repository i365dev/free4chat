const ALLOWED_ORIGINS = new Set([
  "https://free4.chat",
  "https://www.free4.chat",
  "http://localhost:3000",
])

export function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && ALLOWED_ORIGINS.has(origin)
}
