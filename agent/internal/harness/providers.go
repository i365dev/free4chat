package harness

import "github.com/i365dev/free4chat/agent/internal/types"

/*
 * The ordered built-in provider registry.
 *
 * Order is part of the existing contract: doctor output and the policy tests
 * read the registry positionally, exactly as the previous launcher slice did.
 *
 * Every capability value below is a named product decision backed by the
 * evidence in its comment. None of it is derived from ACP advertisement.
 */
var builtInProviders = []Provider{
	{
		ID:          "hermes",
		DisplayName: "Hermes",
		Command:     "hermes",
		Args:        []string{"acp"},
		Maturity:    types.MaturityNative,
		Security:    types.SecurityTrustedRoom,
		Notes: "Experimental trusted-room mode only. Current Hermes ACP has native file, shell, browser, memory, " +
			"and code tools; its current CLI exposes no safe no-tools profile.",
		Capabilities: Capabilities{
			// ACP advertises list/resume but session/list returned ZERO native
			// sessions in the #409 probe: a known native id loads, discovery
			// does not. Not eligible until that is fixed and re-verified.
			SessionContinuation: SessionContinuationSourceSupported,
			// Two independent sessions made concurrent progress with correct
			// stream routing in an earlier probe. The merged isolated-lane
			// lifecycle suite has not certified Hermes at N=2 yet, so the
			// production cap remains serial. This is an evidence gap, not an
			// inherent provider limitation.
			Execution: ExecutionCapability{
				Mode:     types.TaskExecutionSerial,
				Evidence: types.TaskExecutionProbeConcurrencyObserved,
			},
			// #297: the ACP relay code exists, but the tested default/native
			// policy executed directly and emitted no permission request.
			Approval: ApprovalNativePolicyNoPrompt,
		},
	},
	{
		ID:          "opencode",
		DisplayName: "OpenCode",
		Command:     "opencode",
		Args:        []string{"acp", "--pure"},
		Maturity:    types.MaturityNative,
		Security:    types.SecurityTrustedRoom,
		Notes:       "Native ACP over stdio in pure mode (external plugins disabled); OpenCode defaults to loopback, an ephemeral port, and mDNS disabled.",
		Capabilities: Capabilities{
			// #409 runtime evidence: list + load are advertised and a native
			// session is discoverable/replayable, but the next ACP prompt
			// failed with -32603. Verified partial, so NOT eligible.
			SessionContinuation: SessionContinuationSourceSupported,
			// Concurrent cross-session progress with correct routing was observed,
			// but the merged isolated-lane lifecycle and approval suite has not
			// certified N=2 yet. Keep the production cap serial until it does.
			Execution: ExecutionCapability{
				Mode:     types.TaskExecutionSerial,
				Evidence: types.TaskExecutionProbeConcurrencyObserved,
			},
			// #297: Room approval was verified only with an isolated local
			// policy that configured bash/edit/external_directory = ask; the
			// default policy executes directly. Both facts must be preserved.
			Approval: ApprovalPartial,
		},
	},
	{
		ID:          "codex",
		DisplayName: "Codex",
		Command:     "npx",
		Args:        []string{"-y", "@agentclientprotocol/codex-acp@1.12.0"},
		Maturity:    types.MaturityBridge,
		Security:    types.SecurityTrustedRoom,
		Environment: map[string]string{"INITIAL_AGENT_MODE": "read-only"},
		Notes:       "Official ACP bridge for Codex in explicit read-only mode; ambient CODEX_CONFIG and INITIAL_AGENT_MODE are ignored.",
		Capabilities: Capabilities{
			// #440 real native CLI -> pinned ACP certification: the standard
			// session/list returned the seeded `exec` thread (25 sessions), an
			// invalid id failed closed, session/load selected the exact thread,
			// and two post-load prompts retained its codeword and associated
			// fact. This is cold/cooperative adoption only, never hot takeover.
			SessionContinuation: SessionContinuationVerified,
			// Concurrent cross-session progress was observed, but the merged
			// isolated-lane lifecycle suite has not certified N=2. The provider
			// also has a known false-settled cancel shape and high process/RSS
			// cost, so the production cap remains serial pending a fresh probe.
			Execution: ExecutionCapability{
				Mode:     types.TaskExecutionSerial,
				Evidence: types.TaskExecutionProbeConcurrencyObserved,
			},
			// #426 re-verification against codex-acp 1.12.0 + Codex 0.154.0 in
			// explicit read-only mode, through a REAL browser Room:
			//
			//   command   an out-of-workspace `touch` produced a Room approval
			//             card carrying the exact command, cwd, and all three
			//             native options. Selecting
			//             `accept_execpolicy_amendment` — whose native label
			//             exceeds the Room presentation budget and is therefore
			//             bounded by #429 — ran the command and the same turn
			//             continued; selecting `cancel` ran nothing and the
			//             session stayed usable. The exact native OptionID
			//             round-tripped untouched, and no display text was used
			//             as identity.
			//   file      an edit outside the writable root produced an EDIT
			//             Room card offering allow_once / allow_for_session /
			//             cancel. The ACP round trip was verified end-to-end:
			//             allow edits the file, reject leaves it unchanged, and
			//             the same native session remains usable.
			//
			// The previous 1.6.2 pin could not do this at all: its command
			// request carried no presentation metadata, so the Runtime refused
			// it before any Room request existed.
			//
			// It stays PARTIAL because this verification is deliberately
			// SCOPED. openai/codex#21982 (sandbox_permissions /
			// require_escalated surfacing), agentclientprotocol/codex-acp#310
			// (mode/config coupling) and #401 (MCP execution mediation) all
			// remain OPEN, and no MCP path or alternate sandbox/mode
			// combination was exercised. Only the ordinary command and
			// file-change paths in read-only mode are verified.
			Approval: ApprovalPartial,
		},
	},
	{
		ID:          "claude",
		DisplayName: "Claude",
		Command:     "npx",
		Args:        []string{"-y", "@agentclientprotocol/claude-agent-acp@0.70.0"},
		Maturity:    types.MaturityBridge,
		Security:    types.SecurityTrustedRoom,
		Notes:       "ACP bridge maintained by the Agent Client Protocol project.",
		Capabilities: Capabilities{
			// Source-supported (session/list delegates to the Claude Agent SDK
			// session store) but NOT runtime-verified. Not eligible.
			SessionContinuation: SessionContinuationSourceSupported,
			// The local CLI reports logged-in API-key auth, but the pinned ACP
			// prompt did not settle within the certification ceiling. That is an
			// external bridge/tooling block, not evidence of serial semantics.
			// Keep the provider serial and unverified until a clean run exists.
			Execution: ExecutionCapability{
				Mode:     types.TaskExecutionSerial,
				Evidence: types.TaskExecutionProbeUnverified,
			},
			// #297: production-verified Room-native ACP approval.
			Approval: ApprovalRoomMediated,
		},
	},
	{
		ID:          "pi",
		DisplayName: "Pi",
		Command:     "npx",
		Args:        []string{"-y", "pi-acp@0.0.33"},
		Maturity:    types.MaturityBridge,
		Security:    types.SecurityTrustedRoom,
		Notes:       "ACP bridge listed by the official ACP registry.",
		// VERIFIED against the pinned bridge on a real 122-session store:
		// omitting `cwd` returned 0 sessions (pi-acp@0.0.33 substitutes its
		// own last session cwd), while an explicitly empty `cwd` returned the
		// real page across 22 project directories. Without this, "Continue
		// session" would have shown an empty picker for this enabled
		// Harness.
		SessionListGlobalCwd: types.GlobalSessionListCwdEmpty,
		Capabilities: Capabilities{
			// The ONLY Harness verified end-to-end (#409): native Pi CLI
			// session -> ACP session/list -> session/load -> continued
			// conversation with preserved context, re-confirmed by the 0.5.34
			// dogfood. This is the single place where Pi is selected as
			// enabled.
			SessionContinuation: SessionContinuationVerified,
			// Pi is the only Harness currently enabled for cross-session
			// execution. The evidence is axis-scoped: it proves N=2 under the
			// merged isolated-process lifecycle, while N=4 remains a separate
			// resource/certification target. pi-acp's historical closeAllExcept
			// behavior is contained by the per-lane process boundary; it is no
			// longer a Free4Chat shared-process architecture blocker.
			//
			//   concurrency   3/3 trials: an independent session B settled in
			//                 1.2-2.6s while session A ran a 45-60s tool call,
			//                 and A emitted 1-3 of its own notifications
			//                 strictly inside B's window (real interleaving,
			//                 not queue jumping).
			//   routing       B's streamed text never contained A's token or
			//                 vice versa, across every trial.
			//   isolation     B did not know a codeword seeded into A, while A
			//                 still remembered it: two session/new sessions in
			//                 one bridge process are separate conversations.
			//   cancel        with BOTH sessions running a shell tool,
			//                 session/cancel on A settled A in 2.2s with no
			//                 completion token while B ran on to completion.
			//   crash         killing ONE per-session `pi` worker left the
			//                 bridge alive and a brand-new session C working;
			//                 only the killed conversation was lost.
			//   cost          ~180 MB idle, ~360-425 MB with two active
			//                 sessions.
			//
			// Pi is also the only Harness with SessionContinuation verified,
			// which is exactly the workflow that makes two independent
			// retained sessions normal for the product.
			Execution: ExecutionCapability{
				Mode:          types.TaskExecutionCrossSession,
				MaxConcurrent: 2,
				Evidence:      types.TaskExecutionProbeVerifiedCrossSession,
			},
			// #297: tested native/default policy executed directly and emitted
			// no Room approval request. (The pi-acp lifecycle/hang findings of
			// #421/#427 are session-materialization semantics, not approval.)
			Approval: ApprovalNativePolicyNoPrompt,
		},
	},
}

// ListProviders returns independent copies of the built-in provider registry.
func ListProviders() []Provider {
	out := make([]Provider, len(builtInProviders))
	for index, provider := range builtInProviders {
		out[index] = provider.clone()
	}
	return out
}

// ProviderByID resolves one built-in provider by id.
func ProviderByID(id string) (Provider, error) {
	for _, candidate := range builtInProviders {
		if candidate.ID == id {
			return candidate.clone(), nil
		}
	}
	return Provider{}, &UnknownLauncherError{ID: id}
}
