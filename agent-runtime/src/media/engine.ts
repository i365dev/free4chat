/** The selected realtime media engine for this runtime process.
 * Pion is the normal engine after #103/#105; werift remains an explicit
 * developer/legacy fallback via FREE4CHAT_MEDIA_ENGINE=werift. */
export function resolveMediaEngineName(
  environment: {
    FREE4CHAT_MEDIA_ENGINE?: string
  } = process.env
): "pion" | "werift" {
  return environment.FREE4CHAT_MEDIA_ENGINE === "werift" ? "werift" : "pion"
}
