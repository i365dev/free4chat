package harness

import (
	"reflect"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * Provider seam regression tests (#427).
 *
 * The provider registry replaced the launcher slice as the source of truth, so
 * these tests pin the EFFECTIVE policy the old registry produced: same order,
 * same launch material, same cwd quirk, same continuation enablement, same
 * execution policy. A change here is a product decision, never a refactor
 * side effect.
 */

func TestBuiltInProvidersMatchPreviousLauncherPolicy(t *testing.T) {
	type want struct {
		id           string
		command      string
		args         []string
		env          map[string]string
		maturity     types.LauncherMaturity
		security     types.LauncherSecurity
		continuation bool
		globalCwd    types.LauncherSessionListGlobalCwd
		execution    types.TaskExecutionPolicy
	}
	expected := []want{
		{
			id: "hermes", command: "hermes", args: []string{"acp"},
			maturity: types.MaturityNative, security: types.SecurityTrustedRoom,
			continuation: false,
			execution:    types.TaskExecutionPolicy{Probe: types.TaskExecutionProbeConcurrencyObserved, Concurrency: types.TaskExecutionSerial},
		},
		{
			id: "opencode", command: "opencode", args: []string{"acp", "--pure"},
			maturity: types.MaturityNative, security: types.SecurityTrustedRoom,
			continuation: false,
			execution:    types.TaskExecutionPolicy{Probe: types.TaskExecutionProbeConcurrencyObserved, Concurrency: types.TaskExecutionSerial},
		},
		{
			id: "codex", command: "npx", args: []string{"-y", "@agentclientprotocol/codex-acp@1.6.2"},
			env:      map[string]string{"INITIAL_AGENT_MODE": "read-only"},
			maturity: types.MaturityBridge, security: types.SecurityTrustedRoom,
			continuation: false,
			execution:    types.TaskExecutionPolicy{Probe: types.TaskExecutionProbeConcurrencyObserved, Concurrency: types.TaskExecutionSerial},
		},
		{
			id: "claude", command: "npx", args: []string{"-y", "@agentclientprotocol/claude-agent-acp@0.70.0"},
			maturity: types.MaturityBridge, security: types.SecurityTrustedRoom,
			continuation: false,
			execution:    types.TaskExecutionPolicy{Probe: types.TaskExecutionProbeUnverified, Concurrency: types.TaskExecutionSerial},
		},
		{
			id: "pi", command: "npx", args: []string{"-y", "pi-acp@0.0.33"},
			maturity: types.MaturityBridge, security: types.SecurityTrustedRoom,
			continuation: true,
			globalCwd:    types.GlobalSessionListCwdEmpty,
			execution:    types.TaskExecutionPolicy{Probe: types.TaskExecutionProbeVerifiedCrossSession, Concurrency: types.TaskExecutionCrossSession, MaxConcurrent: 2},
		},
	}

	launchers := ListLaunchers()
	if len(launchers) != len(expected) {
		t.Fatalf("launcher registry must keep its size: got %d want %d", len(launchers), len(expected))
	}
	for index, want := range expected {
		got := launchers[index]
		if got.ID != want.id {
			t.Fatalf("registry order changed at %d: got %q want %q", index, got.ID, want.id)
		}
		if got.Command != want.command {
			t.Fatalf("%s command: got %q want %q", want.id, got.Command, want.command)
		}
		if !reflect.DeepEqual(got.Args, want.args) {
			t.Fatalf("%s args: got %v want %v", want.id, got.Args, want.args)
		}
		if !reflect.DeepEqual(got.Environment, want.env) {
			t.Fatalf("%s environment: got %v want %v", want.id, got.Environment, want.env)
		}
		if got.Maturity != want.maturity || got.Security != want.security {
			t.Fatalf("%s classification: got %s/%s want %s/%s", want.id, got.Maturity, got.Security, want.maturity, want.security)
		}
		if got.TaskSessionContinuation != want.continuation {
			t.Fatalf("%s continuation: got %v want %v", want.id, got.TaskSessionContinuation, want.continuation)
		}
		if got.SessionListGlobalCwd != want.globalCwd {
			t.Fatalf("%s global cwd spelling: got %q want %q", want.id, got.SessionListGlobalCwd, want.globalCwd)
		}
		if !reflect.DeepEqual(got.TaskExecution, want.execution) {
			t.Fatalf("%s execution policy: got %+v want %+v", want.id, got.TaskExecution, want.execution)
		}
	}
}

func TestSessionContinuationStatusOnlyVerifiedEnables(t *testing.T) {
	cases := map[SessionContinuationStatus]bool{
		SessionContinuationUnsupported:     false,
		SessionContinuationSourceSupported: false,
		SessionContinuationVerified:        true,
	}
	for status, enabled := range cases {
		if status.Enabled() != enabled {
			t.Fatalf("status %q Enabled() = %v, want %v", status, status.Enabled(), enabled)
		}
	}
}

func TestExecutionCapabilityFailSafeAndProjection(t *testing.T) {
	// The zero value must stay the pre-#421 serial behavior.
	var zero ExecutionCapability
	if lanes := zero.Policy().Lanes(); lanes != 1 {
		t.Fatalf("zero execution capability must project to one lane, got %d", lanes)
	}
	cross := ExecutionCapability{
		Mode:          types.TaskExecutionCrossSession,
		MaxConcurrent: 2,
		Evidence:      types.TaskExecutionProbeVerifiedCrossSession,
	}
	if got := cross.Policy(); got.Lanes() != 2 || got.Concurrency != types.TaskExecutionCrossSession {
		t.Fatalf("cross-session projection lost its policy: %+v", got)
	}
}

func TestProviderRegistryReturnsIndependentCopies(t *testing.T) {
	providers := ListProviders()
	providers[0].Args[0] = "mutated"
	providers[0].Capabilities.SessionContinuation = SessionContinuationVerified
	if providers[0].Environment != nil {
		providers[0].Environment["X"] = "mutated"
	}
	again, err := ProviderByID("hermes")
	if err != nil {
		t.Fatalf("hermes provider: %v", err)
	}
	if again.Args[0] != "acp" {
		t.Fatalf("registry copy mutation leaked into the registry: %v", again.Args)
	}
	if again.Capabilities.SessionContinuation != SessionContinuationSourceSupported {
		t.Fatalf("capability mutation leaked into the registry: %q", again.Capabilities.SessionContinuation)
	}

	if _, err := ProviderByID("nonexistent"); err == nil {
		t.Fatal("unknown provider id must fail")
	} else if _, ok := err.(*UnknownLauncherError); !ok {
		t.Fatalf("unknown provider must keep the launcher error type, got %T", err)
	}
}
