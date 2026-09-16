// #75/#406: the single action-scoped Turnstile challenge this product
// renders — requesting a fresh Human realtime session. The browser sets it on
// the widget and the Worker requires Siteverify to echo it back, so a token
// minted by a different widget on the same domain-locked sitekey can never be
// replayed against /api/sfu/session.
//
// Kept in one shared module so the client and the Worker can never drift.
export const TURNSTILE_ACTION = "sfu-session"
