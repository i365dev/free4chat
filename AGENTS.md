# free4chat — Agent Development Guide

## Project Overview

Real-time voice + text + file chat. No sign-up. Cloudflare-native stack.

- **Live URL**: https://free4.chat
- **Branch**: `cloudflare` (default)
- **Stack**: Next.js 15 → Cloudflare Worker via `@opennextjs/cloudflare`

## Directory Layout

```
free4chat/
├── app/
│   ├── scripts/
│   │   └── patch-worker.mjs          # post-build: bundles BotSession.ts and appends export to .open-next/worker.js
│   ├── src/
│   │   ├── common/
│   │   │   ├── consts.tsx            # LOCAL_PEER_ID = "local-peer-id"
│   │   │   ├── types.tsx             # UserInfo, Message, Color interfaces
│   │   │   └── utils.ts             # strToBgColor, umamiEvent, hashRoom, etc.
│   │   ├── do/
│   │   │   └── BotSession.ts         # Durable Object: Luna chat history + hourly rate limit
│   │   ├── hooks/
│   │   │   └── useChatRoom.ts        # Core RTK hook — all meeting logic lives here
│   │   ├── components/
│   │   │   ├── TurnstileGate.tsx     # Full-page bot challenge wrapper (used in _app.tsx)
│   │   │   ├── RoomContent.tsx       # Room layout (participant grid + chat panel + @luna relay)
│   │   │   ├── UserCard.tsx          # Per-participant card (audio + avatar + mute + screenshare)
│   │   │   ├── AudioVisualizer.tsx
│   │   │   └── TextChatCard.tsx      # Chat sidebar (messages, activity strip, Luna pill)
│   │   └── pages/
│   │       ├── _app.tsx              # App wrapper — loads TurnstileGate around all pages
│   │       ├── index.tsx             # Landing / room join
│   │       ├── room.tsx              # Dynamic import of RoomContent (ssr: false)
│   │       └── api/
│   │           ├── token.ts          # POST /api/token — token server (runs in Worker)
│   │           └── bot.ts            # POST /api/bot — proxies message to BotSession DO
│   ├── wrangler.jsonc                # main: .open-next/worker.js, KV + DO bindings
│   ├── open-next.config.ts
│   └── package.json                  # cf-build = opennextjs build + patch-worker.mjs
└── .github/workflows/
    └── deploy-web.yml                # Lint + type-check → deploy (push to cloudflare branch)
```

## RTK SDK Usage Pattern

The app uses **`useRealtimeKitClient`** (low-level hook) — NOT the higher-level React hooks. All RTK state is managed imperatively through the `meeting` object inside `useChatRoom.ts`.

```ts
const [meeting, initMeeting] = useRealtimeKitClient();
```

### Key meeting APIs currently used

| Object                        | API                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `meeting.self`                | `.name`, `.audioEnabled`, `.audioTrack`, `.enableAudio()`, `.disableAudio()`                   |
| `meeting.self` events         | `"audioUpdate"`                                                                                |
| `meeting.participants.joined` | `.toArray()`, events: `"participantJoined"`, `"participantLeft"`, `"audioUpdate"`              |
| `meeting.chat`                | `.messages`, `.sendTextMessage()`, `.sendImageMessage()`, `.sendFileMessage()`, `"chatUpdate"` |
| `meeting`                     | `.join()`, `.leaveRoom()`                                                                      |

### Screen share APIs (RTK native, fully supported)

```ts
meeting.self.enableScreenShare();
meeting.self.disableScreenShare();
meeting.self.screenShareEnabled; // boolean
meeting.self.screenShareTracks; // { video: MediaStreamTrack, audio?: MediaStreamTrack }

participant.screenShareEnabled;
participant.screenShareTracks;

meeting.self.on("screenShareUpdate", buildParticipants);
meeting.participants.joined.on("screenShareUpdate", buildParticipants);
```

Permission check: `meeting.self.permissions.canProduceScreenshare // "ALLOWED" | "NOT_ALLOWED" | "CAN_REQUEST"`

## Data Flow

```
useRealtimeKitClient()
  └── meeting (imperative RTK object)
        └── useChatRoom.ts
              ├── buildParticipants() → UserInfo[]
              └── returns { participants, messages, muteSelf, toggleScreenShare,
                            sendText, sendFile, sendAction, error, resolvedRoomType, ... }
                    └── RoomContent.tsx
                          ├── @luna intercept → POST /api/bot → BotSession DO
                          ├── ScreenShareViewer (one at a time)
                          ├── UserCard.tsx (per participant)
                          │     ├── <audio> element
                          │     └── AudioVisualizer
                          └── TextChatCard.tsx
                                ├── message list (text / file / image / bot / action)
                                ├── Activity strip (Draw · Poll · Games · Luna pill)
                                └── text input + send + file upload
```

## Type Contracts

### UserInfo (common/types.tsx)

```ts
export interface UserInfo {
  name: string;
  room: string;
  className?: string;
  audioStream?: MediaStream | null;
  screenShareStream?: MediaStream | null;
  screenShareEnabled?: boolean;
  peerId: string;
  muteState?: boolean;
}
```

### Message (common/types.tsx)

```ts
export interface Message {
  peerId: string;
  name: string;
  type: "text" | "image" | "file" | "bot" | "action";
  text?: string;
  fileLink?: string;
  fileName?: string;
  fileSize?: number;
  actionType?: ActionType;
  actionPayload?: Record<string, string>;
}
```

## Token API (api/token.ts)

- **Method**: POST `/api/token`
- **Body**: `{ room: string, name: string, type?: "audio" | "screenshare", enableBot?: boolean, turnstileToken: string }`
- **Response**: `{ authToken: string, roomType: "audio" | "screenshare", botEnabled: boolean, typeConflict?: boolean }`
- **Error codes**: 400 (bad input), 403 (forbidden origin or Turnstile failure), 410 (room expired), 429 (rate limited), 500

Security layers (in order):

1. **Origin whitelist** — blocks non-browser requests without `Origin: https://free4.chat`
2. **KV rate limiting** — 20 req/60s per IP
3. **Turnstile verification** — if `TURNSTILE_SECRET_KEY` is set, `turnstileToken` is **required**; missing or invalid token → 403
4. Input length limits: room ≤ 64 chars, name ≤ 32 chars
5. Room max age: 2 hours (returns 410 after)

Room type logic: first caller sets room type; subsequent callers inherit from KV. `typeConflict: true` when caller requested a different type.

## Bot API (api/bot.ts)

- **Method**: POST `/api/bot`
- **Body**: `{ room: string, userMessage: string, userName: string }`
- **Response**: `{ reply: string }` or `{ error: "rate_limited" | "ai_error" }`

Routes to `BotSession` Durable Object keyed by room name. `RoomContent.tsx` intercepts outgoing chat messages that contain `@luna`, strips the mention, and calls this endpoint. Bot reply is injected back into the local message list as `type: "bot"`.

## BotSession Durable Object (do/BotSession.ts)

Per-room stateful AI session. Keyed by room name via `env.BOT_SESSION.idFromName(room)`.

**Storage** (DO KV, `state.storage`):

- `history`: `AiMessage[]` — last 20 messages, persists across requests within the DO lifetime
- `hourly`: `{ window: number, count: number }` — hourly rate limit state

**Limits**: 30 AI calls per room per hour (`HOURLY_RATE_LIMIT`). History capped at 20 messages (`MAX_HISTORY`).

**Model**: `workers-ai/@cf/zai-org/glm-4.7-flash` via Cloudflare AI Gateway (OpenAI-compatible `/compat` endpoint).

### Critical: BotSession DO Export

`opennextjs-cloudflare build` always emits `.open-next/worker.js` and ignores any custom `main` in `wrangler.jsonc`. To export `BotSession`, `cf-build` runs `scripts/patch-worker.mjs` after the opennextjs build:

1. esbuild bundles `src/do/BotSession.ts` → `.open-next/do-bot-session.js`
2. Appends `export { BotSession } from "./do-bot-session.js"` to `.open-next/worker.js`

`wrangler.jsonc` `"main"` must point to `.open-next/worker.js` (not `worker.ts` — that file no longer exists and opennextjs ignores it anyway).

## Turnstile Gate (components/TurnstileGate.tsx)

Wraps the entire app in `_app.tsx`. On first page load (any URL — landing page, shared room link, etc.):

1. Checks `sessionStorage.ts_token`
2. If present → renders children immediately (no re-challenge within the same browser session)
3. If absent → shows full-screen challenge; on pass, stores token in `sessionStorage.ts_token` and renders children

The stored token is sent as `turnstileToken` in the `/api/token` POST body. `api/token.ts` verifies it server-side when `TURNSTILE_SECRET_KEY` is set.

**Env var**: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` — baked into the frontend at build time (GitHub Actions secret). Falls back to Cloudflare's always-pass test key `1x00000000000000000000AA` locally.

## Analytics (Umami + Google Analytics)

Both `umami` and `gtag` are loaded in `_document.tsx`. All custom event tracking uses `umamiEvent(name, data)` from `common/utils.ts`. Room names are anonymized with `hashRoom()` (FNV-1a) before sending.

### Current Events

| Event          | Trigger                                     | Key Properties                                   |
| -------------- | ------------------------------------------- | ------------------------------------------------ |
| `RoomJoin`     | User clicks Join on landing page            | `type`, `roomHash`                               |
| `Room`         | User enters the room                        | `type`, `roomHash`                               |
| `RoomSize`     | Participant count crosses a bucket boundary | `bucket` (1/2-3/4-9/10+), `roomType`, `roomHash` |
| `ChatActivity` | First text message; every file/image sent   | `type`, `roomHash`                               |
| `ChatAction`   | whiteboard / poll / game / vote actions     | `type`, optional `gameId`, `roomHash`            |
| `ScreenShare`  | User toggles screen share                   | `action` (start\|stop), `roomHash`               |

## Styling Conventions

- Tailwind CSS only — no inline styles except for dynamic values
- Dark theme: `bg-gray-900` base, `border-gray-700` borders, `text-white`
- Participant cards: `rounded-xl border border-gray-700 px-3 py-3`, bg from `strToBgColor(name)`
- Bot messages: `bg-violet-900/60 text-violet-100 ring-1 ring-violet-700/50`
- Luna pill in activity strip: `border-violet-600 bg-violet-900/40 text-violet-300`

## Development

```bash
cd app
cp .dev.vars.example .dev.vars   # fill CF_API_TOKEN, CF_ACCOUNT_ID, RTK_APP_ID,
                                  # RTK_SCREENSHARE_PRESET_NAME, RTK_AUDIO_PRESET_NAME,
                                  # CF_AIG_TOKEN, CF_AI_GATEWAY_BASEURL
yarn dev                          # localhost:3000
```

`.dev.vars` is gitignored. `TURNSTILE_SECRET_KEY` is optional locally — omit it and Turnstile is skipped in dev.

`CF_AI_GATEWAY_BASEURL` must end at `/compat` with no trailing path. The OpenAI SDK appends `/chat/completions` automatically.

## Deployment

Push to `cloudflare` branch with changes in `app/**` → GitHub Actions lints + type-checks → deploys.

Manual: `yarn cf-build && yarn cf-deploy` (needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars).

## Key Constraints

- `room.tsx` uses `dynamic(() => import("../components/RoomContent"), { ssr: false })` — required, RTK breaks under SSR
- `initMeeting` called with `defaults: { audio: true, video: false }` — video off by default
- `LOCAL_PEER_ID = "local-peer-id"` is the sentinel for the local participant
- `buildParticipants()` is the single source of truth for participant state — always rebuild the full list, never patch individual entries
- `joinedRef` prevents double-joining on React StrictMode double-effect
- `resolvedRoomType` (state in `useChatRoom.ts`) reflects the actual room type from the token API — use this for UI gating (e.g. screenshare button visibility)
- `activeSharePeerId` tracks which participant's screen is displayed — only one `ScreenShareViewer` renders at a time
- Split pane ratio (`splitRatio`): auto-sets to 75 when screen sharing, 50 otherwise; drag handle is desktop-only (`hidden md:block`)
- IME input fix: `isComposingRef` in `TextChatCard.tsx` prevents Enter from submitting during CJK composition
- `*.tsbuildinfo` is gitignored — do not commit it
- `scripts/patch-worker.mjs` must run after every `opennextjs-cloudflare build` — it is part of `cf-build`, not standalone

## Future Technical Directions

### SQLite-backed Durable Objects

`BotSession` uses DO KV storage (`state.storage.get/put`). Fine for current use (small history array + two counters). If data model grows (per-user memory, room summaries, structured queries), migrate to `this.state.storage.sql`. Migration is straightforward; also unlocks Cloudflare Data Studio for debugging production data.

### Cloudflare Actors Library

Higher-level abstraction over DOs — replaces manual `fetch()` dispatch with typed RPC. Worth adopting if `BotSession` grows multiple methods or is called from multiple Workers. No benefit at current scale.

### Voice Bot (Luna Phase 2)

Requires `@cloudflare/voice` Durable Object (STT → LLM → TTS) + Cloudflare Calls API track bridging into RTK. Estimated latency: ~700–900ms all-Cloudflare. See issue #52.

### Slash / @ Command Picker

Type `/` or `@` in chat input → inline picker for commands and bot mentions. Build together with any voice bot work. See issue #53.
