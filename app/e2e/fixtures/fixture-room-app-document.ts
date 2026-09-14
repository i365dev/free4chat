/**
 * The Core-owned fixture Room App document (#398).
 *
 * It is deliberately boring: no framework, no backend, no media, no external
 * network. It exists only to probe the REAL Core host boundary — the catalog
 * lookup, trusted-origin iframe, sandbox, bootstrap handshake and MessagePort
 * bridge are all production code; only this document is local.
 *
 * Shape choices are intentional:
 * - tall content (60 rows) so the App needs vertical scrolling, which must not
 *   push host controls out of reach;
 * - a 1200px-wide row inside an intentional local horizontal scroll container,
 *   so page-level overflow assertions can prove they only tolerate local
 *   scrollers;
 * - a handful of ordinary controls plus one deterministic outbound host
 *   message.
 */
export const FIXTURE_ROOM_APP_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Core Fixture App</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: #0b1220;
        color: #e5e7eb;
        font: 14px/1.45 system-ui, sans-serif;
      }
      #fixture-root { padding: 12px; }
      h1 { font-size: 16px; margin: 0 0 4px; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
      button { font: inherit; padding: 6px 10px; }
      input { font: inherit; padding: 6px 8px; min-width: 160px; }
      .muted { color: #9ca3af; }
      .wide-wrap { overflow-x: auto; border: 1px solid #1f2937; margin: 8px 0; }
      #fixture-wide {
        min-width: 1200px;
        padding: 10px;
        background: repeating-linear-gradient(
          90deg, #111827 0 80px, #0f172a 80px 160px
        );
      }
      #fixture-scroll {
        max-height: 40vh;
        overflow-y: auto;
        border: 1px solid #1f2937;
        padding: 8px;
        margin: 8px 0;
      }
      #fixture-scroll li { padding: 4px 0; border-bottom: 1px solid #111827; }
      ol { margin: 0; padding-left: 20px; }
    </style>
  </head>
  <body>
    <div id="fixture-root">
      <h1>Core Fixture App</h1>
      <p class="muted">
        host status:
        <span id="fixture-status" data-testid="fixture-status" data-state="waiting">waiting for host</span>
        · participants: <span id="fixture-participants" data-testid="fixture-participants">0</span>
        · self: <span id="fixture-self" data-testid="fixture-self">-</span>
      </p>
      <div class="row">
        <button id="fixture-ping" data-testid="fixture-ping" type="button">Send host message</button>
        <button id="fixture-tick" data-testid="fixture-tick" type="button">Local tick</button>
        <input id="fixture-note" data-testid="fixture-note" aria-label="Fixture note" placeholder="note" />
        <span class="muted">ticks: <span id="fixture-ticks" data-testid="fixture-ticks">0</span></span>
      </div>
      <p class="muted">
        last host payload: <span id="fixture-echo" data-testid="fixture-echo">none</span>
        · host error: <span id="fixture-host-error" data-testid="fixture-host-error">none</span>
      </p>
      <section class="wide-wrap" aria-label="Intentional local horizontal scroll">
        <div id="fixture-wide">wide fixture row (1200px, local scroll only)</div>
      </section>
      <section id="fixture-scroll" data-testid="fixture-scroll" aria-label="Long fixture content">
        <ol id="fixture-rows" data-testid="fixture-rows"></ol>
      </section>
    </div>
    <script>
      (function () {
        var port = null
        var appInstanceId = null
        var ticks = 0

        function text(id, value) {
          var element = document.getElementById(id)
          if (element) element.textContent = String(value)
        }

        var rows = document.getElementById("fixture-rows")
        for (var index = 1; index <= 60; index += 1) {
          var item = document.createElement("li")
          item.textContent = "fixture row " + index
          rows.appendChild(item)
        }

        function report() {
          ticks += 1
          text("fixture-ticks", ticks)
        }

        document.getElementById("fixture-tick").addEventListener("click", report)

        document.getElementById("fixture-ping").addEventListener("click", function () {
          report()
          if (!port) return
          port.postMessage({
            type: "milestone",
            appInstanceId: appInstanceId,
            milestone: "engaged",
          })
          port.postMessage({
            type: "sendReliable",
            appInstanceId: appInstanceId,
            payload: { type: "fixture-ping", seq: ticks },
          })
        })

        window.addEventListener("message", function (event) {
          var data = event.data
          if (!data || data.type !== "room-app-bootstrap") return
          var nextPort = event.ports && event.ports[0]
          if (!nextPort) return
          port = nextPort
          appInstanceId = data.appInstanceId
          port.onmessage = function (messageEvent) {
            var message = messageEvent.data
            if (!message || message.appInstanceId !== appInstanceId) return
            if (message.type === "ready") {
              text("fixture-participants", (message.participants || []).length)
              text("fixture-self", message.self ? message.self.name : "-")
              var status = document.getElementById("fixture-status")
              if (status) {
                status.textContent = "ready"
                status.setAttribute("data-state", "ready")
              }
              return
            }
            if (message.type === "reliable" || message.type === "realtime") {
              text("fixture-echo", JSON.stringify(message.payload))
              return
            }
            if (message.type === "error") {
              text("fixture-host-error", message.error || "error")
            }
          }
          port.start()
          port.postMessage({
            type: "ready",
            appInstanceId: appInstanceId,
            handshakeToken: data.handshakeToken,
          })
        })
      })()
    </script>
  </body>
</html>
`
