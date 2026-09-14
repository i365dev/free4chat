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

## Room App host compatibility gate (#398)

`yarn e2e:room-app-host` runs `e2e/room-app-host/room-app-host.spec.ts` on one
shared local harness across five viewports:

```text
chromium-desktop        1440x900
webkit-desktop          1440x900
webkit-phone             390x844  (touch, mobile viewport)
webkit-tablet-portrait   820x1180 (touch, mobile viewport)
webkit-tablet-landscape 1180x820  (touch, mobile viewport)
```

It exercises the **generic host contract** only — join Room, open a Room App,
enter fullscreen, verify the exit control is inside the viewport and receives
the pointer, exit, hide, reopen — and asserts geometry/semantic invariants
rather than pixels. Lab Apps keep owning their own business-flow tests.

What is real: catalog loader + v1 schema validation, trusted-origin allow-list,
iframe sandbox, bootstrap handshake, MessagePort host bridge, host chrome,
Stage/fullscreen/Room shell lifecycle, the local Worker and RoomSession
Durable Object.

What is local: the Lab-owned control-plane catalog response (a Core-owned
fixture App served through the real loader) and the fixture App document
itself, plus the external analytics/font scripts, which are stubbed so the
gate is hermetic and CI never writes to production analytics.

What is not covered: this is WebKit, **not real iOS/iPadOS Safari**, and it is
not a media/TURN/audio-quality test. Media is deliberately faked (loopback
Realtime, synthetic microphone) so the suite stays deterministic.

```bash
cd app
npx playwright install --with-deps chromium webkit   # one-time
yarn e2e:room-app-host
```

Failure artifacts: `test-results/` (screenshot + trace per failed project) and
`playwright-report/`; the CI workflow uploads both. There are no screenshot
baselines.

### Harness prerequisites this suite needed

Two narrow local-harness gaps had to be closed for the Room App host surface to
be exercisable (see `e2e/room/run-local-worker.mjs`):

1. `wrangler.jsonc` binds the Lab-owned control-plane service, which
   `createTestHarness()` does not deploy, so workerd refused to boot. The
   harness now starts a tiny local control-plane stub worker
   (`e2e/room/control-plane-stub.ts`) with the production worker name, catalog
   URL and bounded v1 schema, and resolves the binding with the documented
   test-only `bindingOverrides` seam. Production configuration is untouched.
2. The fake Cloudflare Realtime upstream returned a single fixed data-channel
   id for every `datachannels/new` request. The Room App host lane requests two
   negotiated channels (reliable + realtime) and Core fails closed when the
   returned ids do not line up, which silently disabled the entire Room App
   surface. The fake now returns one unique id per requested channel, like the
   real API.
