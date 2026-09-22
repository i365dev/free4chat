/**
 * The deliberately small wire contract for an Agent-generated Task Room App.
 * This is an internal V0 contract, not a public SDK or package format.
 */

export const GENERATED_ROOM_APP_VERSION = 1 as const
export const MAX_GENERATED_APPS_PER_ROOM = 4
export const MAX_GENERATED_APP_BUNDLE_BYTES = 48 * 1024
export const MAX_GENERATED_APP_STATE_BYTES = 16 * 1024
export const MAX_GENERATED_APP_UPDATE_BYTES = 4 * 1024
// Generated state writes are more expensive than ordinary App messages because
// every accepted update persists and broadcasts the Room snapshot.
export const GENERATED_APP_STATE_WINDOW_MS = 10 * 1000
export const GENERATED_APP_STATE_MAX_MUTATIONS_PER_WINDOW = 40
export const GENERATED_APP_STATE_MAX_BYTES_PER_WINDOW = 64 * 1024
export const GENERATED_APP_CHUNK_SIZE = 16 * 1024

const MAX_TITLE_LENGTH = 80
const MAX_HTML_LENGTH = 20 * 1024
const MAX_CSS_LENGTH = 12 * 1024
const MAX_JS_LENGTH = 32 * 1024
const SAFE_TITLE = /^[^<>\u0000-\u001f\u007f]+$/

export interface GeneratedRoomAppBundle {
  version: typeof GENERATED_ROOM_APP_VERSION
  manifest: {
    title: string
    networkOrigins: []
  }
  html: string
  css: string
  js: string
  initialState: Record<string, unknown>
}

export interface GeneratedRoomAppPublication {
  appInstanceId: string
  taskRequestId: string
  title: string
  bundleBytes: number
  /** Replaceable application bundle revision; stateRevision is separate. */
  bundleRevision: number
  stateRevision: number
  createdAt: number
  updatedAt: number
}

export interface GeneratedRoomAppDocument {
  publication: GeneratedRoomAppPublication
  bundle: GeneratedRoomAppBundle
  state: Record<string, unknown>
}

export type GeneratedRoomAppValidation =
  | { ok: true; bundle: GeneratedRoomAppBundle; bytes: number }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function serializedBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return null
  }
}

function safeJsonObject(
  value: unknown,
  maxBytes: number
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const bytes = serializedBytes(value)
  return bytes !== null && bytes <= maxBytes
}

function safeSource(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/\u0000|<\/script|<iframe\b|<object\b|<embed\b|javascript:/i.test(value)
  )
}

export function validateGeneratedRoomAppBundle(
  value: unknown
): GeneratedRoomAppValidation {
  if (!isRecord(value))
    return { ok: false, error: "generated_app_bundle_object" }
  if (
    !hasOnlyKeys(value, [
      "version",
      "manifest",
      "html",
      "css",
      "js",
      "initialState",
    ]) ||
    value.version !== GENERATED_ROOM_APP_VERSION ||
    !isRecord(value.manifest) ||
    !hasOnlyKeys(value.manifest, ["title", "networkOrigins"]) ||
    typeof value.manifest.title !== "string" ||
    value.manifest.title.length === 0 ||
    value.manifest.title.length > MAX_TITLE_LENGTH ||
    !SAFE_TITLE.test(value.manifest.title) ||
    !Array.isArray(value.manifest.networkOrigins) ||
    value.manifest.networkOrigins.length !== 0 ||
    !safeSource(value.html, MAX_HTML_LENGTH) ||
    !safeSource(value.css, MAX_CSS_LENGTH) ||
    !safeSource(value.js, MAX_JS_LENGTH) ||
    !safeJsonObject(value.initialState, MAX_GENERATED_APP_STATE_BYTES)
  )
    return { ok: false, error: "generated_app_bundle_invalid" }

  const bytes = serializedBytes(value)
  if (bytes === null || bytes > MAX_GENERATED_APP_BUNDLE_BYTES)
    return { ok: false, error: "generated_app_bundle_too_large" }

  return {
    ok: true,
    bytes,
    bundle: value as unknown as GeneratedRoomAppBundle,
  }
}

export function validateGeneratedRoomAppState(
  value: unknown
):
  | { ok: true; state: Record<string, unknown>; bytes: number }
  | { ok: false; error: string } {
  if (!safeJsonObject(value, MAX_GENERATED_APP_STATE_BYTES))
    return { ok: false, error: "generated_app_state_invalid" }
  const bytes = serializedBytes(value)
  if (bytes === null || bytes > MAX_GENERATED_APP_STATE_BYTES)
    return { ok: false, error: "generated_app_state_too_large" }
  return { ok: true, state: value, bytes }
}

/**
 * Build the opaque-origin document used by the strict generated iframe. The
 * host bridge is the only way the generated business code can reach Room
 * capabilities; CSP also makes accidental native networking fail closed.
 */
export function generatedRoomAppSrcDoc(bundle: GeneratedRoomAppBundle): string {
  const bridge = `
    (() => {
      let port = null;
      let appInstanceId = "";
      let revision = 0;
      let sharedState = {};
      const sharedListeners = new Set();
      const participantListeners = new Set();
      const api = {
        app: { get appInstanceId() { return appInstanceId; } },
        self: null,
        participants: [],
        events: {
          onSharedChange(listener) { if (typeof listener === "function") sharedListeners.add(listener); return () => sharedListeners.delete(listener); },
          onParticipants(listener) { if (typeof listener === "function") participantListeners.add(listener); return () => participantListeners.delete(listener); }
        },
        shared: {
          get() { return sharedState; },
          get revision() { return revision; },
          set(next) {
            if (!port || !next || typeof next !== "object" || Array.isArray(next)) return false;
            port.postMessage({ type: "sendGeneratedState", appInstanceId, expectedRevision: revision, state: next });
            return true;
          }
        }
      };
      window.free4chat = api;
      window.addEventListener("message", (event) => {
        const message = event.data;
        const transferred = event.ports && event.ports[0];
        if (!message || message.type !== "room-app-bootstrap" || !transferred) return;
        appInstanceId = message.appInstanceId;
        port = transferred;
        port.onmessage = (incoming) => {
          const value = incoming.data;
          if (!value || value.appInstanceId !== appInstanceId) return;
          if (value.type === "ready") {
            api.self = value.self;
            api.participants = value.participants || [];
            if (value.shared) { sharedState = value.shared.state || {}; revision = value.shared.revision || 0; }
            for (const listener of participantListeners) listener(api.participants);
            for (const listener of sharedListeners) listener(sharedState, revision, value.shared && value.shared.sourceParticipantId);
            return;
          }
          if (value.type === "shared_state") {
            sharedState = value.state || {};
            revision = value.revision || 0;
            for (const listener of sharedListeners) listener(sharedState, revision, value.sourceParticipantId);
            return;
          }
          if (value.type === "participant_join" || value.type === "participant_leave") {
            api.participants = value.type === "participant_join"
              ? [...api.participants.filter((p) => p.participantId !== value.participant.participantId), value.participant]
              : api.participants.filter((p) => p.participantId !== value.participant.participantId);
            for (const listener of participantListeners) listener(api.participants);
          }
        };
        port.start();
        port.postMessage({ type: "ready", appInstanceId, handshakeToken: message.handshakeToken });
      });
    })();
  `
  const script = (source: string) => source.replace(/<\/script/gi, "<\\/script")
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src data:;"><style>${script(
    bundle.css
  )}</style></head><body>${script(bundle.html)}<script>${script(
    bridge
  )}</script><script>${script(bundle.js)}</script></body></html>`
}
