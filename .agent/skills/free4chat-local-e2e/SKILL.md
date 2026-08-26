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
   `dist/cli.js daemon` process and join again; the old env keeps otherwise.

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
