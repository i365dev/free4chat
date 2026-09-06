# Homepage signal-collapse browser smoke

`signal-collapse.spec.ts` is the real-browser regression test for the
homepage slogan animation. jsdom cannot prove rendering; this test loads the
actual page in Chromium/WebKit and observes:

- the final slogan is initially present and accessible (SSR + aria-label);
- the animated span deviates into high-entropy noise shortly after mount;
- it converges back to the EXACT deterministic slogan within a bounded
  timeout on every engine.

## Run

```bash
npm i -D playwright
npx playwright install chromium   # one-time browser download
npx playwright test e2e/signal-collapse.spec.ts
```

The config starts `next dev -p 3780` automatically (or reuses an existing
server). This is an optional manual regression path; it is intentionally not
wired into CI.

## Why it exists

Previous fixes relied on unit/PWAs + class assertions. This suite pins the
observable behavior in a real engine, including recovery from throttled or
frozen timers (the component hard-finalizes within ~FINIALIZE_MS regardless
of environment).
