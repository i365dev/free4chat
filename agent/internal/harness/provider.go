package harness

import "github.com/i365dev/free4chat/agent/internal/types"

/*
 * The provider seam (#427).
 *
 * A Provider is the Free4Chat-owned description of ONE Harness implementation:
 * how to launch its bridge, the bridge quirks Free4Chat already normalizes,
 * and exactly which product capabilities have been verified for it.
 *
 * This is the single place where provider-specific facts live. The Runtime
 * never branches on provider identity: it consumes the capabilities through
 * the semantic Contract (contract.go), and the launcher registry
 * (launchers.go) is now a projection of this registry, not a parallel source
 * of truth.
 *
 * Adding a provider means adding one Provider value here plus its own probe
 * evidence. It never means a Runtime, Room, or UI change.
 */

// Provider describes one built-in Harness provider.
type Provider struct {
	// ID is the stable launcher id (also the `--agent` value).
	ID string
	// DisplayName is the human-facing name.
	DisplayName string
	// Maturity and Security mirror the frozen launcher classification.
	Maturity types.LauncherMaturity
	Security types.LauncherSecurity
	// Notes carries the curated product/security note shown by discovery
	// surfaces.
	Notes string

	// Command, Args, and Environment are the launch material for the bridge.
	// Environment holds explicit launch-time overrides (e.g. Codex read-only
	// mode); it is never ambient process state.
	Command                string
	Args                   []string
	Environment            map[string]string
	SessionConfigFallbacks []types.LauncherSessionConfigFallback

	// SessionListGlobalCwd declares how THIS bridge expresses "no cwd filter"
	// on the ACP session/list wire. ACP makes `cwd` optional, but bridges
	// disagree about what omission MEANS (pi-acp substitutes its own last
	// session cwd), so the workaround is recorded next to the provider it
	// belongs to and nowhere else.
	SessionListGlobalCwd types.LauncherSessionListGlobalCwd

	// Capabilities is the normalized, evidence-labeled product capability set.
	Capabilities Capabilities
}

// Launcher projects the provider into the launcher-registry document that the
// CLI, daemon, doctor, and discovery surfaces already consume. The projection
// is the compatibility surface; Provider is the source of truth.
func (p Provider) Launcher() types.AgentLauncher {
	return types.AgentLauncher{
		ID:                      p.ID,
		DisplayName:             p.DisplayName,
		Command:                 p.Command,
		Args:                    append([]string(nil), p.Args...),
		Maturity:                p.Maturity,
		Security:                p.Security,
		Notes:                   p.Notes,
		Environment:             cloneProviderEnvironment(p.Environment),
		SessionConfigFallbacks:  append([]types.LauncherSessionConfigFallback(nil), p.SessionConfigFallbacks...),
		TaskSessionContinuation: p.Capabilities.SessionContinuation.Enabled(),
		SessionListGlobalCwd:    p.SessionListGlobalCwd,
		TaskExecution:           p.Capabilities.Execution.Policy(),
	}
}

// clone returns an independent copy so callers can never mutate the registry.
func (p Provider) clone() Provider {
	p.Args = append([]string(nil), p.Args...)
	p.Environment = cloneProviderEnvironment(p.Environment)
	p.SessionConfigFallbacks = append([]types.LauncherSessionConfigFallback(nil), p.SessionConfigFallbacks...)
	return p
}

func cloneProviderEnvironment(env map[string]string) map[string]string {
	if env == nil {
		return nil
	}
	out := make(map[string]string, len(env))
	for key, value := range env {
		out[key] = value
	}
	return out
}
