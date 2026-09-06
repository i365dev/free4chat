# Homepage signal-collapse browser smoke

`signal-collapse.spec.ts` is the real-browser regression test for the
homepage slogan animation. jsdom cannot prove rendering; this test loads the
actual page in Chromium/WebKit and observes:

- the final slogan is initially present and accessible (SSR + aria-label);
- the animated span deviates into high-entropy noise shortly after mount;
- it converges back to the EXACT deterministic slogan within a bounded
  timeout on every engine.

## Run

The dev dependency (`@playwright/test`) and the `e2e:homepage` script are
committed. From a clean checkout:

```bash
yarn install                       # restores @playwright/test
npx playwright install             # one-time browser download (chromium + webkit)
yarn e2e:homepage
```

`yarn e2e:homepage` runs `playwright test e2e/signal-collapse.spec.ts
--config=e2e/playwright.config.ts`. This is an optional manual regression
path; it is intentionally not wired into CI.

## Why it exists

Previous fixes relied on unit/PWAs + class assertions. This suite pins the
observable behavior in a real engine, including recovery from throttled or
frozen timers (the component hard-finalizes within ~FINIALIZE_MS regardless
of environment).

## Production parity

The config builds and serves the app with `next build && next start`
(production bundle), and runs the spec on BOTH Chromium and WebKit —
matching the engines used for the investigation evidence.

## Room control-plane E2E

`yarn e2e:room` runs `e2e/room/room.spec.ts`: two real browsers against the
real local Worker + RoomSession Durable Object (via `createTestHarness`),
with only the Cloudflare Realtime upstream and the browser media bootstrap
faked. See `.agent/skills/free4chat-local-e2e/SKILL.md` for the full local
testing guide and the control-plane-vs-media boundary.
