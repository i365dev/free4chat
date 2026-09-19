// Package harness owns the local ACP boundary: launcher registry, safe
// environment filtering, untrusted-room prompt rendering, and the ACP v1
// client adapter that wakes one retained Harness session per room turn.
package harness

import (
	"errors"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// builtInLaunchers mirrors the frozen Node registry exactly: explicit
// supported Harnesses, each trusted-room/experimental (ACP is a control
// protocol, not a sandbox).
//
// TaskSessionContinuation is this registry's ONE product-level support policy
// (#409). It is NOT a capability advertisement and must never be derived from
// `sessionCapabilities.list` / `loadSession`: the #409 spike proved OpenCode
// and Hermes advertise both and still cannot continue a native session, while
// Pi was verified end-to-end. See types.AgentLauncher for the full contract.
var builtInLaunchers = []types.AgentLauncher{
	{
		ID:          "hermes",
		DisplayName: "Hermes",
		Command:     "hermes",
		Args:        []string{"acp"},
		Maturity:    types.MaturityNative,
		Security:    types.SecurityTrustedRoom,
		Notes: "Experimental trusted-room mode only. Current Hermes ACP has native file, shell, browser, memory, " +
			"and code tools; its current CLI exposes no safe no-tools profile.",
		// ACP advertises list/resume but session/list returned ZERO native
		// sessions in the #409 probe: a known native id loads, discovery does
		// not. Not eligible until that is fixed and re-verified.
		TaskSessionContinuation: false,
		// #421 probe: two independent sessions made concurrent progress with
		// correct stream routing. The rest of the isolation suite (conversation
		// isolation, exact cancel isolation, per-session crash isolation) was
		// not run for this bridge, so it stays SERIAL.
		TaskExecution: types.TaskExecutionPolicy{
			Probe:       types.TaskExecutionProbeConcurrencyObserved,
			Concurrency: types.TaskExecutionSerial,
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
		// #409 runtime evidence: list + load are advertised and a native
		// session is discoverable/replayable, but the next ACP prompt failed
		// with -32603. Verified partial, so NOT eligible.
		TaskSessionContinuation: false,
		// #421 probe: concurrent cross-session progress with correct routing
		// observed, but no isolation suite yet. SERIAL.
		TaskExecution: types.TaskExecutionPolicy{
			Probe:       types.TaskExecutionProbeConcurrencyObserved,
			Concurrency: types.TaskExecutionSerial,
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
		// Source-supported (session/list asks Codex for `cli`/`vscode`/`exec`/
		// `appServer` threads; load/resume call threadResume) but NOT
		// runtime-verified for the exact native-CLI -> ACP continuation path.
		TaskSessionContinuation: false,
		// #421 probe: concurrent cross-session progress with correct routing
		// observed, but no isolation suite yet, and two concurrent sessions
		// measured ~26 processes / ~820 MB. SERIAL.
		TaskExecution: types.TaskExecutionPolicy{
			Probe:       types.TaskExecutionProbeConcurrencyObserved,
			Concurrency: types.TaskExecutionSerial,
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
		// Source-supported (session/list delegates to the Claude Agent SDK
		// session store) but NOT runtime-verified. Not eligible.
		TaskSessionContinuation: false,
		// #421 probe could not run: the local bridge credentials were expired,
		// so every prompt failed to authenticate. An errored prompt is not
		// evidence about prompt concurrency, so this stays UNVERIFIED + SERIAL.
		TaskExecution: types.TaskExecutionPolicy{
			Probe:       types.TaskExecutionProbeUnverified,
			Concurrency: types.TaskExecutionSerial,
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
		// The ONLY Harness verified end-to-end (#409): native Pi CLI session
		// -> ACP session/list -> session/load -> continued conversation with
		// preserved context, re-confirmed by the 0.5.34 dogfood. This is the
		// single place where Pi is selected as enabled.
		TaskSessionContinuation: true,
		// VERIFIED against the pinned bridge on a real 122-session store:
		// omitting `cwd` returned 0 sessions (pi-acp@0.0.33 substitutes its
		// own last session cwd), while an explicitly empty `cwd` returned the
		// real page across 22 project directories. Without this, "Continue
		// session" would have shown an empty picker for the only enabled
		// Harness.
		SessionListGlobalCwd: types.GlobalSessionListCwdEmpty,
		// The ONE Harness whose cross-session execution is enabled (#421),
		// and the only one with the full probe suite:
		//
		//   concurrency   3/3 trials: an independent session B settled in
		//                 1.2-2.6s while session A ran a 45-60s tool call, and
		//                 A emitted 1-3 of its own notifications strictly
		//                 inside B's window (real interleaving, not queue
		//                 jumping).
		//   routing       B's streamed text never contained A's token or vice
		//                 versa, across every trial.
		//   isolation     B did not know a codeword seeded into A, while A
		//                 still remembered it: two session/new sessions in one
		//                 bridge process are separate conversations.
		//   cancel        with BOTH sessions running a shell tool,
		//                 session/cancel on A settled A in 2.2s with no
		//                 completion token while B ran on to completion.
		//   crash         killing ONE per-session `pi` worker left the bridge
		//                 alive and a brand-new session C working; only the
		//                 killed conversation was lost.
		//   cost          ~180 MB idle, ~360-425 MB with two active sessions.
		//
		// Pi is also the only Harness with TaskSessionContinuation, which is
		// exactly the workflow that makes two independent retained sessions
		// normal for the product.
		TaskExecution: types.TaskExecutionPolicy{
			Probe:         types.TaskExecutionProbeVerifiedCrossSession,
			Concurrency:   types.TaskExecutionCrossSession,
			MaxConcurrent: 2,
		},
	},
}

// ListLaunchers returns a copy of the built-in launcher registry.
func ListLaunchers() []types.AgentLauncher {
	out := make([]types.AgentLauncher, len(builtInLaunchers))
	for i := range builtInLaunchers {
		out[i] = cloneLauncher(builtInLaunchers[i])
	}
	return out
}

// GetLauncher resolves one built-in launcher by id.
func GetLauncher(id string) (types.AgentLauncher, error) {
	for _, candidate := range builtInLaunchers {
		if candidate.ID == id {
			return cloneLauncher(candidate), nil
		}
	}
	return types.AgentLauncher{}, &UnknownLauncherError{ID: id}
}

// CustomLauncher builds a trusted-local custom ACP command launcher.
func CustomLauncher(command string, args []string) (types.AgentLauncher, error) {
	if strings.TrimSpace(command) == "" {
		return types.AgentLauncher{}, errors.New("ACP agent command cannot be empty")
	}
	copied := make([]string, len(args))
	copy(copied, args)
	return types.AgentLauncher{
		ID:          "custom",
		DisplayName: "Custom ACP Agent",
		Command:     command,
		Args:        copied,
		Maturity:    types.MaturityPreview,
		Security:    types.SecurityTrustedRoom,
	}, nil
}

func cloneLauncher(launcher types.AgentLauncher) types.AgentLauncher {
	launcher.Args = append([]string(nil), launcher.Args...)
	if launcher.Environment != nil {
		env := make(map[string]string, len(launcher.Environment))
		for key, value := range launcher.Environment {
			env[key] = value
		}
		launcher.Environment = env
	}
	return launcher
}
