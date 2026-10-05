---
name: free4chat-deployed-worker-dogfood
description: Run a real, temporary Cloudflare Workers dogfood flow for Free4Chat without touching production.
---

# Free4Chat deployed Worker dogfood

Use this skill only for a deliberately temporary deployed-worker verification
of Free4Chat. It is separate from local browser E2E and from media-specific
experiment procedures.

## Safety boundary

- Record the exact repository, branch, and commit SHA before building.
- Run `wrangler whoami` before any deployment and stop if the account is not
  the intended operator account.
- Never deploy, mutate, tail, or delete `free4chat-realtime` or any production
  route. Use a unique `workers.dev` Worker name only.
- Create a uniquely named temporary KV namespace if the Worker needs one.
- Use an explicit temporary Turnstile bypass only in the temporary Worker
  configuration. Do not change production secrets or committed config.
- Never read plaintext deployment secrets during Agent-driven deployed
  dogfood. Required real Worker secrets must come from pre-provisioned
  Cloudflare Secrets Store bindings. The Agent may inspect store IDs/names,
  secret names, and binding names, but must never retrieve or receive secret
  values. `.dev.vars` remains supported for Human/local development outside
  this deployed-agent workflow.
- Treat the SFU App ID and App Secret as separate inputs. `SFU_APP_ID` is a
  non-secret Worker variable; `SFU_APP_SECRET` is a secret. They must belong to
  the same Cloudflare Calls/SFU app. Bind the pre-provisioned secret as
  `SFU_APP_SECRET_STORE` using the Secrets Store binding below; never fetch its
  value or ask a Human to paste it. Do not assume the App ID can be inferred
  from the Secret Store name or metadata, and do not reuse the production
  Worker’s App ID for a disposable environment.
- Resolve the dogfood App ID before creating temporary Cloudflare resources.
  Use the Cloudflare dashboard or the read-only Calls app-list endpoint
  (`GET /accounts/{account_id}/calls/apps`) with `Calls Read` permission, then
  match the app name to the pre-provisioned dogfood secret. `wrangler whoami`
  must show the intended account; if the matching App ID or required read
  permission is unavailable, stop before creating a Worker or KV namespace.
  Ask only for the non-secret App ID or the missing read permission, never the
  App Secret value.
- Keep temporary configuration outside the repository whenever possible.
- Do not create a release, tag, production deployment, or automatic merge.

Example temporary Wrangler binding (use the verified store ID and secret name;
these are metadata, not secret values):

```jsonc
"vars": {
  "SFU_APP_ID": "<verified-dogfood-app-id>",
  "TURNSTILE_DISABLED": "true"
},
"secrets_store_secrets": [
  {
    "binding": "SFU_APP_SECRET_STORE",
    "store_id": "<verified-store-id>",
    "secret_name": "<verified-dogfood-secret-name>"
  }
]
```

Cloudflare Secrets Store bindings expose `get()` on the Worker environment; the
secret value is fetched only by the deployed Worker at runtime. The App ID is
configured separately because it is a Worker variable, not a Secrets Store
secret.

## Provenance and deployment

1. Confirm `git status`, branch, and `git rev-parse HEAD`; preserve unrelated
   worktree changes.
2. Create a unique Worker name containing the PR/issue and short SHA, and a
   temporary config with the correct service/self-reference and Durable Object
   bindings for the target branch. Keep the config under a private temporary
   directory.
3. Verify required bindings and secrets without displaying values. Pass the
   temporary Worker origin through the narrow local origin/MCP allow-list only
   for the dogfood run, and remove that source change before commit.
4. Deploy only the temporary Worker to `workers.dev`. Capture the Worker name,
   URL, version, and temporary resource ids as private operator evidence.
5. Record production Worker/version state before and after the run; the two
   records must be unchanged.

## Real acceptance flow

- Use two independent browser contexts, not two tabs sharing cookies/storage.
- Create or join one real Room and use a real Agent participant through the
  supported MCP/Runtime path. Do not fake Task events or call Durable Object
  storage directly.
- Install and join the Runtime without STT/TTS provider setup by default.
  Ordinary deployed Task acceptance must not prompt for speech-provider
  passwords. Configure speech credentials only for an explicitly requested
  STT, Live Transcript, Meeting Notes, or Voice Reply acceptance case.
- Submit a natural Human request. For generated Task Apps, the request must
  not name bridge APIs or prescribe `publish_generated_app`; the Agent must
  discover `generated-app describe --json` from the compact Task affordance.
- Verify the Agent receives and accepts the exact Task, publishes one App, and
  that both Humans can open the same App and perform writes in both directions.
- Verify refresh/rejoin, hide/reopen, revision conflict recovery, publisher
  departure/lease expiry, and the relevant security/bounds behavior.
- Check that official Room Apps remain in the Room-level catalog launcher while
  a generated Task App remains on the selected Task surface.
- Record only non-sensitive evidence: statuses, counts, revision numbers,
  stable app identity in redacted form, visible UI outcomes, and test results.
  Never record handles, participant tokens, session ids, cookies, raw secrets,
  private prompts, or raw console output.

## Cleanup and verification

1. Close browser contexts and stop local helper processes.
2. Delete the explicitly named temporary Worker and KV namespace; use the
   narrow resource ids captured for this run, never a wildcard or production
   name.
3. Remove temporary origin/MCP allow-list edits and temporary config files.
4. Verify the temporary URL no longer serves the Worker, the temporary KV is
   gone, production Worker/version state is unchanged, and `git status` contains
   only intentional PR changes.
5. Run the repository's required type, web, Go, and CI checks after cleanup.
6. Keep the PR Draft unless the natural-language acceptance flow and all
   required evidence pass. Do not merge automatically.
