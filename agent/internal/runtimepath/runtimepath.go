// Package runtimepath owns the canonical per-user Free4Chat Runtime data root.
package runtimepath

import (
	"os"
	"path/filepath"
	"strings"
)

// Directory returns the shared local Runtime root.
func Directory() string {
	if dir := strings.TrimSpace(os.Getenv("FREE4CHAT_AGENT_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".free4chat-agent"
	}
	return filepath.Join(home, ".free4chat-agent")
}
