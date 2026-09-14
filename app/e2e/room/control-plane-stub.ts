// Local stand-in for the Lab-owned Room App control plane (#398).
//
// The production Worker reaches the Lab catalog through the
// ROOM_APP_CONTROL_PLANE service binding. `createTestHarness()` does not deploy
// that Worker, so workerd refuses to boot at all unless the binding resolves
// inside the harness (see the ROOM_APP_CONTROL_PLANE bindingOverrides in
// run-local-worker.mjs).
//
// This stub keeps the SAME worker name, the SAME fixed catalog URL and the SAME
// bounded v1 schema Core validates in production. It serves one Core-owned
// fixture App and nothing else: no fallback catalog, no production behaviour,
// no external network.
import { fixtureRoomAppCatalogJson } from "../fixtures/room-app-fixture"

const CATALOG_PATH = "/_catalog.json"

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== CATALOG_PATH)
      return new Response("not found", { status: 404 })
    return new Response(fixtureRoomAppCatalogJson(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // The catalog is a public, credential-free GET; Core's loader sends
        // `credentials: "omit"` and reads it as a bounded CORS response.
        "access-control-allow-origin": "*",
      },
    })
  },
}
