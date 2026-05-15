# free4chat — Agent Development Guide

## Project Overview

Real-time voice + text + file chat. No sign-up. Cloudflare-native stack.

- **Live URL**: https://free4.chat
- **Branch**: `cloudflare` (default)
- **Stack**: Next.js 14 → Cloudflare Worker via `@opennextjs/cloudflare`

## Directory Layout

```
free4chat/
├── app/                          # Everything lives here
│   ├── src/
│   │   ├── common/
│   │   │   ├── consts.tsx        # LOCAL_PEER_ID = "local-peer-id"
│   │   │   ├── types.tsx         # UserInfo, Message, Color interfaces
│   │   │   └── utils.ts          # strToBgColor and other helpers
│   │   ├── hooks/
│   │   │   └── useChatRoom.ts    # Core RTK hook — all meeting logic lives here
│   │   ├── components/
│   │   │   ├── RoomContent.tsx   # Room layout (participant grid + chat panel)
│   │   │   ├── UserCard.tsx      # Per-participant card (audio + avatar + mute)
│   │   │   ├── AudioVisualizer.tsx
│   │   │   └── TextChatCard.tsx  # Chat sidebar
│   │   └── pages/
│   │       ├── index.tsx         # Landing / room join
│   │       ├── room.tsx          # Dynamic import of RoomContent (ssr: false)
│   │       └── api/
│   │           └── token.ts      # POST /api/token — token server (runs in Worker)
│   ├── wrangler.jsonc            # KV binding: ROOMS_KV
│   ├── open-next.config.ts
│   └── package.json
└── .github/workflows/
    └── deploy-web.yml            # Push app/** → cloudflare branch → auto-deploy
```

## RTK SDK Usage Pattern

The app uses **`useRealtimeKitClient`** (low-level hook) — NOT the higher-level React hooks. All RTK state is managed imperatively through the `meeting` object inside `useChatRoom.ts`.

```ts
const [meeting, initMeeting] = useRealtimeKitClient()
```

### Key meeting APIs currently used

| Object | API |
|---|---|
| `meeting.self` | `.name`, `.audioEnabled`, `.audioTrack`, `.enableAudio()`, `.disableAudio()` |
| `meeting.self` events | `"audioUpdate"` |
| `meeting.participants.joined` | `.toArray()`, events: `"participantJoined"`, `"participantLeft"`, `"audioUpdate"` |
| `meeting.chat` | `.messages`, `.sendTextMessage()`, `.sendImageMessage()`, `.sendFileMessage()`, `"chatUpdate"` |
| `meeting` | `.join()`, `.leaveRoom()` |

### Screen share APIs (RTK native, fully supported)

```ts
// Self
meeting.self.enableScreenShare()      // starts sharing
meeting.self.disableScreenShare()     // stops sharing
meeting.self.screenShareEnabled       // boolean
meeting.self.screenShareTracks        // { video: MediaStreamTrack, audio?: MediaStreamTrack }

// Remote participant
participant.screenShareEnabled
participant.screenShareTracks         // { video: MediaStreamTrack, audio?: MediaStreamTrack }

// Events (same pattern as audioUpdate)
meeting.self.on("screenShareUpdate", buildParticipants)
meeting.participants.joined.on("screenShareUpdate", buildParticipants)
```

Permission check before calling:
```ts
meeting.self.permissions.canProduceScreenshare // "ALLOWED" | "NOT_ALLOWED" | "CAN_REQUEST"
```

## Data Flow

```
useRealtimeKitClient()
  └── meeting (imperative RTK object)
        └── useChatRoom.ts
              ├── buildParticipants() → UserInfo[]
              │     self + joined participants → mapped to UserInfo shape
              └── returns { participants, messages, muteSelf, toggleScreenShare, error }
                    └── RoomContent.tsx
                          └── UserCard.tsx (per participant)
                                ├── <audio> element
                                └── AudioVisualizer
```

## Type Contracts

### UserInfo (common/types.tsx)
```ts
export interface UserInfo {
  name: string
  room: string
  className?: string
  audioStream?: MediaStream | null
  screenShareStream?: MediaStream | null  // added for screen share
  screenShareEnabled?: boolean            // added for screen share
  peerId: string
  muteState?: boolean
}
```

### Message (common/types.tsx)
```ts
export interface Message {
  peerId: string
  name: string
  type: "text" | "image" | "file"
  text?: string
  fileLink?: string
  fileName?: string
  fileSize?: number
}
```

## Token API (api/token.ts)

- **Method**: POST `/api/token`
- **Body**: `{ room: string, name: string }`
- **Response**: `{ authToken: string }`
- **Error codes**: 400 (bad input), 403 (forbidden origin), 410 (room expired), 429 (rate limited), 500

Security in place:
- Origin whitelist (free4.chat only, dev env exempt)
- KV-based rate limiting: 20 req/60s per IP
- Room max age: 2 hours (returns 410 after)
- Input length limits: room ≤ 64 chars, name ≤ 32 chars

**Never hardcode secrets.** All credentials read from Worker secrets via `getCloudflareContext().env`.

## Styling Conventions

- Tailwind CSS only — no inline styles except for dynamic values
- Dark theme: `bg-gray-900` base, `border-gray-700` borders, `text-white`
- Participant cards: `rounded-xl border border-gray-700 p-4`, bg color from `strToBgColor(name)`
- `className` prop on UserCard is passed from RoomContent for grid sizing

## Development

```bash
cd app
cp .dev.vars.example .dev.vars   # fill CF_API_TOKEN, CF_ACCOUNT_ID, RTK_APP_ID, RTK_PRESET_NAME
yarn dev                          # localhost:3000
```

`.dev.vars` is gitignored. Never commit it.

## Deployment

Push to `cloudflare` branch with changes in `app/**` → GitHub Actions auto-deploys.

Manual: `yarn cf-build && yarn cf-deploy` (needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars).

## Key Constraints

- `room.tsx` uses `dynamic(() => import("../components/RoomContent"), { ssr: false })` — required, RTK breaks under SSR
- `initMeeting` called with `defaults: { audio: true, video: false }` — video off by default
- `LOCAL_PEER_ID = "local-peer-id"` is the sentinel for the local participant
- `buildParticipants()` is the single source of truth for participant state — always rebuild the full list, never patch individual entries
- `joinedRef` prevents double-joining on React StrictMode double-effect
