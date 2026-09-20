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
			// #421 probe: two independent sessions made concurrent progress
			// with correct stream routing. The rest of the isolation suite
			// (conversation isolation, exact cancel isolation, per-session
			// crash isolation) was not run for this bridge, so it stays SERIAL.
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
			// #421 probe: concurrent cross-session progress with correct
			// routing observed, but no isolation suite yet. SERIAL.
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
		Args:        []string{"-y", "@agentclientprotocol/codex-acp@1.6.2"},
		Maturity:    types.MaturityBridge,
		Security:    types.SecurityTrustedRoom,
		Environment: map[string]string{"INITIAL_AGENT_MODE": "read-only"},
		Notes:       "Official ACP bridge for Codex in explicit read-only mode; ambient CODEX_CONFIG and INITIAL_AGENT_MODE are ignored.",
		Capabilities: Capabilities{
			// Source-supported (session/list asks Codex for
			// `cli`/`vscode`/`exec`/`appServer` threads; load/resume call
			// threadResume) but NOT runtime-verified for the exact
			// native-CLI -> ACP continuation path.
			SessionContinuation: SessionContinuationSourceSupported,
			// #421 probe: concurrent cross-session progress with correct
			// routing observed, but no isolation suite yet, and two concurrent
			// sessions measured ~26 processes / ~820 MB. SERIAL.
			Execution: ExecutionCapability{
				Mode:     types.TaskExecutionSerial,
				Evidence: types.TaskExecutionProbeConcurrencyObserved,
			},
			// #297 recorded a bridge/app-server/policy limitation; whether the
			// current pinned bridge emits ACP permission requests is being
			// re-verified in #426. Until that result exists this stays PARTIAL
			// instead of an optimistic upgrade or a permanent "unsupported".
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
			// #421 probe could not run: the local bridge credentials were
			// expired, so every prompt failed to authenticate. An errored
			// prompt is not evidence about prompt concurrency, so this stays
			// UNVERIFIED + SERIAL.
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
		// session" would have shown an empty picker for the only enabled
		// Harness.
		SessionListGlobalCwd: types.GlobalSessionListCwdEmpty,
		Capabilities: Capabilities{
			// The ONLY Harness verified end-to-end (#409): native Pi CLI
			// session -> ACP session/list -> session/load -> continued
			// conversation with preserved context, re-confirmed by the 0.5.34
			// dogfood. This is the single place where Pi is selected as
			// enabled.
			SessionContinuation: SessionContinuationVerified,
			// The ONE Harness whose cross-session execution is enabled (#421),
			// and the only one with the full EXECUTION/ISOLATION probe suite.
			// This evidence is deliberately AXIS-SCOPED: it proves already-
			// materialized independent sessions can execute safely; it does NOT
			// certify the pinned bridge's full session-materialization lifecycle.
			// pi-acp@0.0.33 is known to violate Contract.LoadSession when another
			// session is active (closeAllExcept); distribution remediation is
			// tracked in #431 / upstream svkozak/pi-acp#131. Phase 1 preserves the
			// existing launcher policy here rather than changing behavior inside a
			// structural refactor.
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
