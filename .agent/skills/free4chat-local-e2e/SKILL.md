---
name: free4chat-local-e2e
description: free4chat local full-stack E2E loop — single wrangler instance, Turnstile bypass switches, curl/MCP validation sequences, split-brain DO and daemon env traps. Use when validating room features (messaging, attachments, agent wakeups) against a local Worker+DO+KV stack without deploying.
---

# free4chat local full-stack E2E loop

Use when Worker routes / DO logic / MCP tools changed and the full chain
(browser or curl → Worker → DO → Agent Runtime) must be proven locally.

## Start the single-instance local stack

```bash
cd app
cp ../app/.dev.vars .dev.vars   # needed for real SFU credentials; optional for pure room logic
NEXT_PUBLIC_TURNSTILE_DISABLED=1 npm run cf-build   # client-side Turnstile off (see below)
npx wrangler dev --local --port 3000 \
  --var TURNSTILE_SECRET_KEY: \
  --var AGENT_MEDIA_ENABLED:true
```

Three hard rules (each one cost a debugging cycle):

1. **Port must be 3000.** The origin allow-list (`src/common/origin.ts`)
   only contains `http://localhost:3000`. A different port yields
   `forbidden_origin` for browsers AND for curl-based attachment uploads.
2. **Exactly one wrangler instance.** Two wranglers = two miniflare memory
   spaces = split-brain DO state: messages written through instance A are
   invisible to an agent polling instance B (symptom: "@tag gets no reply").
   Before restarting: `pkill -f "wrangler dev"` and verify
   `lsof -iTCP:<port> -sTCP:LISTEN` is empty.
3. **The daemon process freezes env at first spawn.** After changing
   `FREE4CHAT_MCP_URL` / `FREE4CHAT_STT_PROVIDER` / `DOUBAO_API_KEY`, kill the
   `free4chat-agent daemon` process (Go resident daemon under `agent/`) and
   join again; the old env keeps otherwise.

## Turnstile switches (local bypass)

| Layer               | Mechanism                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Server              | `--var TURNSTILE_SECRET_KEY:` (empty ⇒ `verify()` returns true immediately, see sfu/server.ts)                                    |
| Client              | build-time `NEXT_PUBLIC_TURNSTILE_DISABLED=1` ⇒ useTurnstile loads no widget, requestToken resolves instantly                     |
| Browser widget kept | sitekey must be `1x00000000000000000000` (20 chars); variants with an `AA` suffix are invalid keys and fail with Turnstile 400020 |

Production builds set none of these ⇒ behavior identical to production.

## Browser-free validation sequence (agent routes need no Origin/Turnstile)

Agent routes are listed in `MISSING_ORIGIN_ALLOWED_ROUTES` — omit the Origin
header entirely. Human routes (e.g. `/api/room/attachments`) require
`Origin: http://localhost:3000`.

```bash
# 1. Agent joins (modern envelope + both headers are mandatory; legacy
#    initialize is rejected with -32022 on the deployed dual-era stack)
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -H "Mcp-Method: tools/call" -H "Mcp-Name: join_room" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"join_room","arguments":{"roomId":"r1","name":"Probe"},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientCapabilities":{}}}}'
# participantHandle = base64url(JSON{room,participantId,participantToken});
# participantToken is ONLY inside the handle, never a separate field.

# 2. Human participant (needed for human-only ops like attachment upload)
curl -s -X POST http://localhost:3000/api/sfu/session \
  -H "Origin: http://localhost:3000" -H "Content-Type: application/json" \
  -d '{"room":"r1","name":"LocalHuman","turnstileToken":"x"}'

# 3. Read events (addressed is computed per requesting participant: a message
#    targeted at someone else reads as false here)
wait_for_events {participantHandle, cursor, timeoutSeconds}
```

## Lifecycle traps

- Human participants are reaped within seconds-to-minutes without a live
  WebSocket (401 unauthorized) — create-and-act must happen in one short window.
- Agent lease is 90 s, renewed by wait_for_events; killing a process without
  leave leaves a ghost card until lease expiry.
- Room history can be replayed in full by any new member with cursor=0,
  which makes assertions easy.

## Automated browser Room E2E (the real Worker + real DO)

`app/e2e/room/` is the repeatable control-plane regression: two REAL browser
pages join the same Room through the REAL OpenNext Worker, REAL
`RoomSession` Durable Object, REAL KV bindings, REAL WebSocket and REAL
roster/message broadcast. The only fake layers are external:

- Cloudflare Realtime upstream → loopback fake HTTP server (`SFU_RTC_BASE_URL`
  env override; `src/sfu/server.ts` keeps the real production base when the
  env var is absent);
- browser media bootstrap → Chromium's fake-device flags
  (`--use-fake-device-for-media-stream`) plus a tiny `RTCPeerConnection`
  stub in `room.spec.ts` (the fake SFU's SDP is deliberately unparseable).

Origin handling: the harness binds a transparent TCP relay on
`http://localhost:3000` (the existing production allow-list origin) and
forwards everything untouched — `src/common/origin.ts` is NOT weakened.

```bash
cd app
yarn e2e:room
```

The webServer command runs `NEXT_PUBLIC_TURNSTILE_DISABLED=1 yarn cf-build &&
node e2e/room/run-local-worker.mjs` (Wrangler `createTestHarness()` + fake
Realtime + 3000 TCP relay). Run it at least twice to catch leaked ports or
stale state; the fake Realtime fails CLOSED (503) on any unexpected outbound
call, so a test passing proves no stray external request occurred.

## Which test for which change

| Change                                                        | Test                             |
| ------------------------------------------------------------- | -------------------------------- |
| Homepage visual/headline (signal collapse, CTA, layout)       | `yarn e2e:homepage`              |
| Room layout / chat / participant cards / control-plane wiring | `yarn e2e:room`                  |
| Worker routes / DO logic / MCP tools                          | local curl/MCP flow below        |
| Audio / screen share / Agent Voice / SFU negotiation          | REAL deployed media dogfood only |

> **Local Room E2E proves the collaboration/control plane. It does NOT prove
> the Realtime SFU/media plane.** Do not claim media correctness from a
> harness that fakes `rtc.live.cloudflare.com` or the peer connection.

The manual `wrangler dev --local --port 3000` + curl/MCP/Agent Runtime
workflow below remains the interactive investigation path; the automated
harness and the manual workflow are complementary, not replacements.
