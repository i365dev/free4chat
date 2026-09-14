/**
 * Core-owned Room App fixture for the local E2E harnesses (#398).
 *
 * The compatibility suite must not depend on the production Lab control plane,
 * on a real Lab App runtime, or on any external network. This module is the
 * single source of truth for the fixture App's catalog entry so the Worker-side
 * control-plane stub and the browser-side catalog response cannot drift.
 *
 * Only the *responses* are local: the catalog still travels through Core's real
 * loader, schema validation, trusted-origin allow-list, iframe sandbox,
 * bootstrap handshake and MessagePort host bridge.
 */
export const FIXTURE_ROOM_APP_ID = "core-fixture-app"
export const FIXTURE_ROOM_APP_LABEL = "Core Fixture App"
export const FIXTURE_ROOM_APP_PATH = `/${FIXTURE_ROOM_APP_ID}`

/** The pinned trusted Room App origin (src/common/roomApp.ts). */
export const FIXTURE_ROOM_APP_ORIGIN = "https://room-apps.free4.chat"

/**
 * Lab catalog v1 payload, in the exact shape Core validates: exact keys,
 * `path` pinned to `/<id>`, and a bounded `label`.
 */
export function fixtureRoomAppCatalog(): {
  version: 1
  apps: Array<{ id: string; label: string; path: string; status: string }>
} {
  return {
    version: 1,
    apps: [
      {
        id: FIXTURE_ROOM_APP_ID,
        label: FIXTURE_ROOM_APP_LABEL,
        path: FIXTURE_ROOM_APP_PATH,
        status: "active",
      },
    ],
  }
}

export function fixtureRoomAppCatalogJson(): string {
  return JSON.stringify(fixtureRoomAppCatalog())
}
