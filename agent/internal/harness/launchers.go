// Package harness owns the local ACP boundary: launcher registry, safe
// environment filtering, untrusted-room prompt rendering, and the ACP v1
// client adapter that wakes one retained Harness session per room turn.
package harness

import (
	"errors"
	"os"
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
		Args:        []string{"acp", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false", "--pure"},
		Maturity:    types.MaturityNative,
		Security:    types.SecurityTrustedRoom,
		Notes:       "Local-only ACP server: loopback hostname, ephemeral port, mDNS disabled, and pure mode.",
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
	{
		ID:          "deepseek-harness",
		DisplayName: "DeepSeek Harness",
		Command:     "pnpm",
		Args:        []string{"run", "demo:acp"},
		Maturity:    types.MaturityPreview,
		Security:    types.SecurityTrustedRoom,
		Notes: "Developer-preview automation ACP. Set FREE4CHAT_DEEPSEEK_REPO to its checkout or use a custom " +
			"launcher.",
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

// GetLauncher resolves one built-in launcher by id, applying the DeepSeek
// repo prerequisite.
func GetLauncher(id string) (types.AgentLauncher, error) {
	for _, candidate := range builtInLaunchers {
		if candidate.ID == id {
			launcher := cloneLauncher(candidate)
			if id == "deepseek-harness" {
				repo := os.Getenv("FREE4CHAT_DEEPSEEK_REPO")
				if repo == "" {
					return types.AgentLauncher{}, errDeepSeekRepo
				}
				args := make([]string, 0, len(launcher.Args)+2)
				args = append(args, "--dir", repo)
				args = append(args, launcher.Args...)
				launcher.Args = args
			}
			return launcher, nil
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
