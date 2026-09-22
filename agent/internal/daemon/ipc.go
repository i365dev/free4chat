// Package daemon owns the local runtime control plane: a restrictive Unix
// socket IPC server, the resident-instance registry, per-instance private
// workspaces, and detach-style daemon bootstrap/reuse.
package daemon

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RuntimeDirectory returns the shared local runtime root (overridable via
// FREE4CHAT_AGENT_DIR for tests and sandboxed operators).
func RuntimeDirectory() string {
	if dir := strings.TrimSpace(os.Getenv("FREE4CHAT_AGENT_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".free4chat-agent"
	}
	return filepath.Join(home, ".free4chat-agent")
}

// SocketPath is the local IPC endpoint under the runtime directory.
func SocketPath() string {
	return filepath.Join(RuntimeDirectory(), "daemon.sock")
}

// WorkspacesRoot holds one private 0700 workspace per resident instance.
func WorkspacesRoot() string {
	return filepath.Join(RuntimeDirectory(), "workspaces")
}

// NewID returns a fresh RFC 4122 v4 UUID string.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand unavailable: %v", err)) // pragma: no cover
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// IpcRequest is one newline-delimited IPC operation.
type IpcRequest struct {
	Op           string   `json:"op"`
	Room         string   `json:"room,omitempty"`
	Name         string   `json:"name,omitempty"`
	Agent        string   `json:"agent,omitempty"`
	AgentCommand string   `json:"agentCommand,omitempty"`
	AgentArgs    []string `json:"agentArgs,omitempty"`
	InstanceID   string   `json:"instanceId,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	// ProviderClaim is a one-time opaque 256-bit capability accepted only by
	// join/connect. It is never copied into a response, status, workspace, or log.
	ProviderClaim            string            `json:"providerClaim,omitempty"`
	TargetParticipantID      string            `json:"targetParticipantId,omitempty"`
	RequestID                string            `json:"requestId,omitempty"`
	Decision                 string            `json:"decision,omitempty"`
	Status                   string            `json:"status,omitempty"`
	Summary                  string            `json:"summary,omitempty"`
	Details                  map[string]string `json:"details,omitempty"`
	AttachmentIDs            []string          `json:"attachmentIds,omitempty"`
	TaskRequestID            string            `json:"taskRequestId,omitempty"`
	Surface                  map[string]any    `json:"surface,omitempty"`
	Bundle                   map[string]any    `json:"bundle,omitempty"`
	FileName                 string            `json:"fileName,omitempty"`
	MimeType                 string            `json:"mimeType,omitempty"`
	DataBase64               string            `json:"dataBase64,omitempty"`
	SourceParticipantID      string            `json:"sourceParticipantId,omitempty"`
	BeforeSequence           *int64            `json:"beforeSequence,omitempty"`
	AfterSequence            *int64            `json:"afterSequence,omitempty"`
	Limit                    int               `json:"limit,omitempty"`
	BeforeTranscriptSequence *int64            `json:"beforeTranscriptSequence,omitempty"`
	AfterTranscriptSequence  *int64            `json:"afterTranscriptSequence,omitempty"`
	TranscriptLimit          int               `json:"transcriptLimit,omitempty"`
	LogTail                  int               `json:"logTail,omitempty"`
	// AgentEnv is a map of explicitly authorized Harness environment variable
	// NAMES -> VALUES resolved from the CLI process at join/create time.
	// It is ephemeral launch material: never returned in daemon responses,
	// never persisted to workspace/status/logs, never enters Room/MCP/ACP.
	AgentEnv map[string]string `json:"agentEnv,omitempty"`
	// #409 V1 Pi session handoff (local CLI only). SessionID is an opaque ACP
	// identity: it is accepted from `handoff --adopt`, held by one resident
	// Runtime until it binds to a Task, and never written to status, Room
	// state, workspace files, or logs.
	SessionID     string  `json:"sessionId,omitempty"`
	SessionCursor string  `json:"sessionCursor,omitempty"`
	SessionCwd    *string `json:"sessionCwd,omitempty"`
	// SessionCwd is presence-aware on purpose: `handoff --list` with no --cwd
	// means GLOBAL discovery (the adapter omits cwd from session/list), while
	// `--cwd X` means exactly X. An omitted field and an explicitly empty one
	// are therefore different requests and are never collapsed into "".
	HumanParticipantID string `json:"humanParticipantId,omitempty"`
}

// IpcResponse is the single-line reply envelope.
type IpcResponse struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// DaemonInfo is the bounded local handshake used before a CLI join is
// forwarded to a resident daemon. It deliberately carries only the daemon
// build version; resident instances and their private capabilities stay in
// the existing status projection.
type DaemonInfo struct {
	DaemonVersion string `json:"daemonVersion"`
}

// DecodeRequest parses one raw IPC line.
func DecodeRequest(line []byte) (*IpcRequest, error) {
	var request IpcRequest
	if err := json.Unmarshal(line, &request); err != nil {
		return nil, fmt.Errorf("invalid ipc request: %w", err)
	}
	if request.Op == "" {
		return nil, fmt.Errorf("invalid ipc request: missing op")
	}
	return &request, nil
}
