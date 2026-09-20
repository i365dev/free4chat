// Package harness owns the local ACP boundary: the provider registry, safe
// environment filtering, untrusted-room prompt rendering, the Free4Chat
// semantic Harness contract, and the shared ACP v1 client adapter that wakes
// retained Harness sessions per room turn.
package harness

import (
	"errors"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

/*
 * The launcher registry is now a PROJECTION of the provider registry
 * (providers.go), not a second source of truth. Callers that already read
 * types.AgentLauncher keep working byte-for-byte; the provider seam owns the
 * launch material, the bridge quirks, and the evidence-labeled capability
 * policy behind it.
 */

// ListLaunchers returns the built-in launcher projection of the provider
// registry.
func ListLaunchers() []types.AgentLauncher {
	providers := ListProviders()
	out := make([]types.AgentLauncher, len(providers))
	for index, provider := range providers {
		out[index] = provider.Launcher()
	}
	return out
}

// GetLauncher resolves one built-in launcher by id.
func GetLauncher(id string) (types.AgentLauncher, error) {
	provider, err := ProviderByID(id)
	if err != nil {
		return types.AgentLauncher{}, err
	}
	return provider.Launcher(), nil
}

// CustomLauncher builds a trusted-local custom ACP command launcher.
//
// A custom launcher has no provider entry and therefore no verified product
// capabilities: every capability stays at its fail-safe zero value.
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
