const DEFAULT_MAX_DIAGNOSTIC_LENGTH = 2000

export function redactSecrets(
  value: string,
  secrets: readonly string[] = [],
  maxLength = DEFAULT_MAX_DIAGNOSTIC_LENGTH
): string {
  let result = value
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]")
  }
  result = result.replace(
    /(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
    "$1[REDACTED]"
  )
  result = result.replace(
    /((?:x-api-key|api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[REDACTED]"
  )
  if (result.length <= maxLength) return result
  return `${result.slice(0, Math.max(0, maxLength - 3))}...`
}

export function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = []
): string {
  const message = error instanceof Error ? error.message : "operation failed"
  return redactSecrets(message, secrets)
}
