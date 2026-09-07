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
	},
	{
		ID:          "opencode",
		DisplayName: "OpenCode",
		Command:     "opencode",
		Args:        []string{"acp", "--pure"},
		Maturity:    types.MaturityNative,
		Security:    types.SecurityTrustedRoom,
		Notes:       "Native ACP over stdio in pure mode (external plugins disabled); OpenCode defaults to loopback, an ephemeral port, and mDNS disabled.",
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
	},
	{
		ID:          "claude",
		DisplayName: "Claude",
		Command:     "npx",
		Args:        []string{"-y", "@agentclientprotocol/claude-agent-acp@0.70.0"},
		Maturity:    types.MaturityBridge,
		Security:    types.SecurityTrustedRoom,
		Notes:       "ACP bridge maintained by the Agent Client Protocol project.",
	},
	{
		ID:          "pi",
		DisplayName: "Pi",
		Command:     "npx",
		Args:        []string{"-y", "pi-acp@0.0.33"},
		Maturity:    types.MaturityBridge,
		Security:    types.SecurityTrustedRoom,
		Notes:       "ACP bridge listed by the official ACP registry.",
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
