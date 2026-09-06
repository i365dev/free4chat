// Local Room E2E harness (#275).
//
// Runs the REAL production Worker (wrangler.jsonc) inside Wrangler's modern
// createTestHarness, backed by the REAL RoomSession Durable Object, ROOMS_KV,
// Worker routes and WebSocket handling. Only the Cloudflare Realtime upstream
// is faked (loopback HTTP server), and only the browser media bootstrap is
// shimmed (see room.spec.ts addInitScript).
//
// The harness listens on a dynamic loopback URL. The production origin
// allow-list only accepts e.g. http://localhost:3000, so a tiny loopback
// reverse proxy binds the canonical allowed origin and forwards everything
// (including WebSocket upgrades) to the harness URL. Production origin
// validation is deliberately untouched.
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { createTestHarness } from "wrangler"

const PROXY_HOST = "127.0.0.1"
// The ONLY locally allowed production origin (src/common/origin.ts). This is
// also the documented `wrangler dev --local --port 3000` convention.
const PROXY_PORT = Number(process.env.FREE4CHAT_E2E_PROXY_PORT ?? 3000)

const DUMMY_APP_ID = "test-app"
const DUMMY_APP_SECRET = "test-secret"

// ---------------------------------------------------------------------------
// Fake Cloudflare Realtime upstream (fail-closed).
// ---------------------------------------------------------------------------
function createFakeRealtime() {
  /** @type {Array<{method: string, path: string}>} */
  const requests = []
  /** @type {Array<{method: string, path: string}>} unexpected requests that
   * were NOT explicitly handled — the E2E spec hard-asserts this is empty. */
  const unexpected = []
  const server = http.createServer((req, res) => {
    const path = req.url ?? ""
    if (req.method === "GET" && path === "/__fake/requests") {
      const payload = JSON.stringify({ requests, unexpected })
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      })
      res.end(payload)
      return
    }
    requests.push({ method: req.method ?? "?", path })
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(payload))
      }
      // Exact minimal contract for the HUMAN Room join path
      // (see sfu/server.ts realtimeRequest call sites):
      //   1. /sessions/new        -> { sessionId }
      //   2. /datachannels/establish -> passthrough; {} is enough for the
      //      browser to continue (no renegotiation, no remote description)
      //   3. /datachannels/new    -> { dataChannels: [{ id }] }
      if (req.method === "POST" && path.endsWith("/sessions/new")) {
        send(200, { sessionId: randomUUID() })
        return
      }
      const establish = path.match(
        /\/sessions\/[^/]+\/datachannels\/establish$/
      )
      if (req.method === "POST" && establish) {
        send(200, {})
        return
      }
      const channelsNew = path.match(/\/sessions\/[^/]+\/datachannels\/new$/)
      if (req.method === "POST" && channelsNew) {
        send(200, { dataChannels: [{ id: 1 }] })
        return
      }
      const channelsClose = path.match(
        /\/sessions\/[^/]+\/datachannels\/close$/
      )
      if (req.method === "PUT" && channelsClose) {
        send(200, { dataChannels: [] })
        return
      }
      // Human audio publish: sfu/server.ts requires a usable answer + a mid
      // per local track (usableHumanPublication) before advertising the
      // track. The browser's fake peer connection never parses this SDP.
      const tracksNew = path.match(/\/sessions\/[^/]+\/tracks\/new$/)
      if (req.method === "POST" && tracksNew) {
        send(200, {
          sessionDescription: { type: "answer", sdp: "v=0\r\n" },
          tracks: [{ mid: "0", trackName: "m-audio" }],
        })
        return
      }
      const renegotiate = path.match(/\/sessions\/[^/]+\/renegotiate$/)
      if (req.method === "PUT" && renegotiate) {
        send(200, {})
        return
      }
      // Fail closed: any other outbound call is a test-contract violation,
      // never an accidental network request. The request is recorded so the
      // E2E spec can hard-fail on it even when production semantics would
      // swallow the upstream 503 (e.g. best-effort media cleanup).
      unexpected.push({ method: req.method ?? "?", path })
      console.error(
        `[fake-realtime] UNEXPECTED ${req.method} ${path} — failing closed`
      )
      send(503, { error: "unexpected_sfu_request", path })
      void body
    })
  })
  return {
    requests,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string")
        throw new Error("no loopback")
      return `http://127.0.0.1:${address.port}/v1/apps/${DUMMY_APP_ID}`
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---------------------------------------------------------------------------
// Transparent loopback relay bound to the canonical allowed origin.
// ---------------------------------------------------------------------------
// A plain TCP relay (no HTTP/WebSocket protocol handling) forwards every
// connection — including WebSocket upgrades — untouched to the harness URL.
// The browser sees origin http://localhost:3000, which is already in the
// production allow-list, so src/common/origin.ts is never weakened.
const stateDir =
  process.env.FREEF4CHAT_E2E_STATE_DIR ?? path.join(os.tmpdir(), "f4c-room-e2e")
const fakePortFile = path.join(stateDir, "fake-port.txt")

function createProxy(targetPort) {
  const server = net.createServer((socket) => {
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    socket.on("error", () => socket.destroy())
    upstream.on("error", () => socket.destroy())
  })
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(PROXY_PORT, PROXY_HOST, resolve)
      })
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const fakeRealtime = createFakeRealtime()
  const fakeRealtimeBase = await fakeRealtime.listen()
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(fakePortFile, String(new URL(fakeRealtimeBase).port))
  console.log(
    `[harness] fake realtime at ${fakeRealtimeBase} (port file ${fakePortFile})`
  )

  const server = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          SFU_APP_ID: DUMMY_APP_ID,
          // #275: intercept every Cloudflare Realtime call at the loopback
          // fake; nothing ever reaches rtc.live.cloudflare.com.
          SFU_RTC_BASE_URL: fakeRealtimeBase,
          TURNSTILE_SECRET_KEY: "",
          TURNSTILE_DISABLED: "true",
          AGENT_MEDIA_ENABLED: "false",
        },
        secrets: {
          SFU_APP_SECRET: DUMMY_APP_SECRET,
        },
      },
    ],
  })

  const { url: workerUrl } = await server.listen()
  console.log(`[harness] worker at ${workerUrl}`)

  const proxy = createProxy(workerUrl.port)
  await proxy.listen()
  console.log(`[harness] proxy at http://${PROXY_HOST}:${PROXY_PORT}`)

  const shutdown = async () => {
    console.log(
      `[harness] fake-realtime saw ${fakeRealtime.requests.length} request(s), ${fakeRealtime.unexpected.length} unexpected:`
    )
    for (const request of fakeRealtime.requests)
      console.log(`[fake-realtime] ${request.method} ${request.path}`)
    fs.rmSync(fakePortFile, { force: true })
    await proxy.close()
    await server.close()
    await fakeRealtime.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  console.log("[harness] READY http://localhost:3000")
}

main().catch((error) => {
  console.error("[harness] startup failed:", error)
  process.exit(1)
})
