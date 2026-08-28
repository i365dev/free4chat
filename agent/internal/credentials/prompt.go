package credentials

import "errors"

// ErrCancelled is deliberately bounded. It is safe to report to the invoking
// Agent without revealing whether a value was partially entered.
var ErrCancelled = errors.New("credential provisioning was cancelled")

// PromptForSecret opens a local, OS-owned secure prompt where supported.
// It is never called from MCP, ACP, Room handling, or a Harness turn.
func PromptForSecret(provider, purpose string) (string, error) {
	return promptForSecret(provider, purpose)
}
