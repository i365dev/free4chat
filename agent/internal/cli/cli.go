// Package cli implements command routing, usage, and user-facing error
// formatting for the free4chat-agent binary.
package cli

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/attachments"
	"github.com/i365dev/free4chat/agent/internal/daemon"
	"github.com/i365dev/free4chat/agent/internal/doctor"
	"github.com/i365dev/free4chat/agent/internal/free4chat"
)

const maxAttachmentBytes = attachments.MaxAttachmentBytes
const maxSurfaceBytes = attachments.MaxSurfaceBytes

const mcpEndpointDefault = "https://www.free4.chat/mcp"

func usageText() string {
	return `Usage:
  free4chat-agent join --room <room-id> --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name> [--capability <token>]...
  free4chat-agent join --room <room-id> --agent-command <command> [--agent-arg <arg> ...] --name <name> [--capability <token>]...
  free4chat-agent create --agent <hermes|opencode|codex|claude|pi|deepseek-harness> --name <name> [--capability <token>]...
  free4chat-agent create --agent-command <command> [--agent-arg <arg> ...] --name <name> [--capability <token>]...
  free4chat-agent capabilities [--instance <id>] [--set <token>,<token>,...]
  free4chat-agent peers --room <room-id>
  free4chat-agent collab request --target <participant-id> --summary <text> [--request-id <id>] [--detail key=value]... [--attach <attachment-id>]... [--instance <id>]
  free4chat-agent collab respond --request-id <id> --decision <accepted|declined> [--summary <text>] [--instance <id>]
  free4chat-agent collab result --request-id <id> --status <completed|failed> --summary <text> [--detail key=value]... [--attach <attachment-id>]... [--instance <id>]
  free4chat-agent attach --file <path> [--name <file-name>] [--instance <id>]
  free4chat-agent surface publish --file <snapshot.jpeg|png|webp> [--instance <id>]
  free4chat-agent surface clear [--instance <id>]
  free4chat-agent surface read --participant <participant-id> [--instance <id>]
  free4chat-agent doctor [--json]
  free4chat-agent readiness [--room <room-id>] [--agent <harness>] [--json]
  free4chat-agent status
  free4chat-agent leave <instance-id>
  free4chat-agent stop`
}

// ExitCoder carries a process exit code through Run.
type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string { return e.err.Error() }
func (e *exitError) Unwrap() error { return e.err }

// Main is the binary entrypoint; it returns the desired process exit code.
func Main(args []string) int {
	if err := run(args); err != nil {
		var typed *exitError
		if errors.As(err, &typed) && typed.code == 2 {
			fmt.Fprintln(os.Stderr, typed.err.Error())
			return 2
		}
		message := formatCliError(err)
		if os.Getenv("FREE4CHAT_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "[debug] %v\n", err)
		}
		fmt.Fprintln(os.Stderr, message)
		return 1
	}
	return 0
}

func failUsage() error {
	return &exitError{code: 2, err: errors.New(usageText())}
}

// option returns the value following name, or "".
func option(args []string, name string) string {
	for index, candidate := range args {
		if candidate == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

// hasFlag reports whether the flag token appears anywhere.
func hasFlag(args []string, name string) bool {
	for _, candidate := range args {
		if candidate == name {
			return true
		}
	}
	return false
}

// repeatedOption collects every occurrence of a repeatable flag.
func repeatedOption(args []string, name string) []string {
	values := []string{}
	for index, candidate := range args {
		if candidate == name && index+1 < len(args) {
			values = append(values, args[index+1])
		}
	}
	return values
}

// keyValueOption parses repeatable key=value flags.
func keyValueOption(args []string, name string) (map[string]string, error) {
	details := map[string]string{}
	for _, entry := range repeatedOption(args, name) {
		separator := strings.Index(entry, "=")
		if separator <= 0 {
			return nil, errUsage()
		}
		details[entry[:separator]] = entry[separator+1:]
	}
	return details, nil
}

func errUsage() error { return &exitError{code: 2, err: errors.New(usageText())} }

func run(args []string) error {
	if len(args) == 0 {
		return failUsage()
	}
	command, rest := args[0], args[1:]

	switch command {
	case "daemon":
		return daemon.New().Run()

	case "join":
		room := option(rest, "--room")
		name := option(rest, "--name")
		agent := option(rest, "--agent")
		agentCommand := option(rest, "--agent-command")
		if room == "" || name == "" || (agent == "" && agentCommand == "") ||
			(agent != "" && agentCommand != "") {
			return errUsage()
		}
		return runViaDaemon(&daemon.IpcRequest{
			Op:           "join",
			Room:         room,
			Name:         name,
			Agent:        agent,
			AgentCommand: agentCommand,
			AgentArgs:    repeatedOption(rest, "--agent-arg"),
			Capabilities: repeatedOption(rest, "--capability"),
		})

	case "create":
		name := option(rest, "--name")
		agent := option(rest, "--agent")
		agentCommand := option(rest, "--agent-command")
		// Create-only command shape: no --room exists here by design — the
		// room id is generated server-side and returned inside the invite.
		if hasFlag(rest, "--room") || name == "" ||
			(agent == "" && agentCommand == "") || (agent != "" && agentCommand != "") {
			return errUsage()
		}
		return runViaDaemon(&daemon.IpcRequest{
			Op:           "create",
			Name:         name,
			Agent:        agent,
			AgentCommand: agentCommand,
			AgentArgs:    repeatedOption(rest, "--agent-arg"),
			Capabilities: repeatedOption(rest, "--capability"),
		})

	case "capabilities":
		request := &daemon.IpcRequest{Op: "update-capabilities", InstanceID: option(rest, "--instance")}
		if set := option(rest, "--set"); set != "" {
			capabilities := []string{}
			for _, token := range strings.Split(set, ",") {
				token = strings.TrimSpace(token)
				if token != "" {
					capabilities = append(capabilities, token)
				}
			}
			request.Capabilities = capabilities
		}
		return runViaDaemon(request)

	case "peers":
		room := option(rest, "--room")
		if room == "" {
			return errUsage()
		}
		return runPeers(room)

	case "collab":
		if len(rest) == 0 {
			return errUsage()
		}
		sub, subRest := rest[0], rest[1:]
		switch sub {
		case "request":
			target := option(subRest, "--target")
			summary := option(subRest, "--summary")
			if target == "" || summary == "" {
				return errUsage()
			}
			details, err := keyValueOption(subRest, "--detail")
			if err != nil {
				return err
			}
			return runViaDaemon(&daemon.IpcRequest{
				Op:                  "collab-request",
				InstanceID:          option(subRest, "--instance"),
				TargetParticipantID: target,
				Summary:             summary,
				RequestID:           option(subRest, "--request-id"),
				Details:             details,
				AttachmentIDs:       repeatedOption(subRest, "--attach"),
			})
		case "respond":
			requestID := option(subRest, "--request-id")
			decision := option(subRest, "--decision")
			if requestID == "" || (decision != "accepted" && decision != "declined") {
				return errUsage()
			}
			return runViaDaemon(&daemon.IpcRequest{
				Op:         "collab-response",
				InstanceID: option(subRest, "--instance"),
				RequestID:  requestID,
				Decision:   decision,
				Summary:    option(subRest, "--summary"),
			})
		case "result":
			requestID := option(subRest, "--request-id")
			status := option(subRest, "--status")
			summary := option(subRest, "--summary")
			if requestID == "" ||
				(status != "completed" && status != "failed") ||
				summary == "" {
				return errUsage()
			}
			details, err := keyValueOption(subRest, "--detail")
			if err != nil {
				return err
			}
			return runViaDaemon(&daemon.IpcRequest{
				Op:            "collab-result",
				InstanceID:    option(subRest, "--instance"),
				RequestID:     requestID,
				Status:        status,
				Summary:       summary,
				Details:       details,
				AttachmentIDs: repeatedOption(subRest, "--attach"),
			})
		default:
			return errUsage()
		}

	case "attach":
		filePath := option(rest, "--file")
		if filePath == "" {
			return errUsage()
		}
		data, err := attachments.ReadBounded(filePath, maxAttachmentBytes)
		if err != nil {
			return fmt.Errorf("Attachment must be a non-empty file up to %d bytes", maxAttachmentBytes)
		}
		fileName := option(rest, "--name")
		if fileName == "" {
			base := filePath
			for i := len(filePath) - 1; i >= 0; i-- {
				if filePath[i] == '/' {
					base = filePath[i+1:]
					break
				}
			}
			fileName = base
		}
		return runViaDaemon(&daemon.IpcRequest{
			Op:         "attach",
			InstanceID: option(rest, "--instance"),
			FileName:   fileName,
			MimeType:   attachments.AttachmentMIME(filePath, option(rest, "--mime")),
			DataBase64: encodeBase64(data),
		})

	case "surface":
		if len(rest) == 0 {
			return errUsage()
		}
		sub, subRest := rest[0], rest[1:]
		switch sub {
		case "publish":
			filePath := option(subRest, "--file")
			if filePath == "" {
				return errUsage()
			}
			mimeType, err := attachments.SurfaceMIME(filePath)
			if err != nil {
				return err
			}
			data, readErr := attachments.ReadBounded(filePath, maxSurfaceBytes)
			if readErr != nil {
				return fmt.Errorf("Surface snapshot must be a non-empty file up to %d bytes", maxSurfaceBytes)
			}
			return runViaDaemon(&daemon.IpcRequest{
				Op:         "surface-publish",
				InstanceID: option(subRest, "--instance"),
				MimeType:   mimeType,
				DataBase64: encodeBase64(data),
			})
		case "clear":
			return runViaDaemon(&daemon.IpcRequest{
				Op:         "surface-clear",
				InstanceID: option(subRest, "--instance"),
			})
		case "read":
			participant := option(subRest, "--participant")
			if participant == "" {
				return errUsage()
			}
			return runViaDaemon(&daemon.IpcRequest{
				Op:                  "surface-read",
				InstanceID:          option(subRest, "--instance"),
				SourceParticipantID: participant,
			})
		default:
			return errUsage()
		}

	case "readiness":
		return runReadiness(rest)

	case "doctor":
		report := doctor.Collect()
		if hasFlag(rest, "--json") {
			return printJSON(report)
		}
		fmt.Println(doctor.Format(report))
		return nil

	case "status":
		return runViaDaemon(&daemon.IpcRequest{Op: "status"})

	case "leave":
		if len(rest) == 0 || rest[0] == "" || strings.HasPrefix(rest[0], "--") {
			return errUsage()
		}
		return runViaDaemon(&daemon.IpcRequest{Op: "leave", InstanceID: rest[0]})

	case "stop":
		return runViaDaemon(&daemon.IpcRequest{Op: "stop"})

	default:
		return errUsage()
	}
}

// runViaDaemon performs ensureDaemon + IPC round-trip + pretty print.
func runViaDaemon(request *daemon.IpcRequest) error {
	if err := daemon.EnsureDaemon(); err != nil {
		return err
	}
	result, err := daemon.SendIPC(request)
	if err != nil {
		return err
	}
	return printJSONRaw(result)
}

// runPeers queries room_info directly — read-only discovery works with or
// without a resident instance (#106).
func runPeers(room string) error {
	endpoint := os.Getenv("FREE4CHAT_MCP_URL")
	if endpoint == "" {
		endpoint = mcpEndpointDefault
	}
	client := free4chat.New(endpoint)
	info, err := client.RoomInfo(room)
	if err != nil {
		_ = client.Close()
		return err
	}
	_ = client.Close()
	return printJSON(info)
}

func printJSON(value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func printJSONRaw(raw json.RawMessage) error {
	var buffer strings.Builder
	if err := encodeIndented(&buffer, raw); err != nil {
		return err
	}
	fmt.Println(buffer.String())
	return nil
}

func encodeIndented(buffer *strings.Builder, raw json.RawMessage) error {
	var doc any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		_, _ = buffer.Write(raw)
		return nil
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	_, err = buffer.Write(data)
	return err
}

func encodeBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

var (
	patternAuth    = regexp.MustCompile(`(?i)(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+`)
	patternSecrets = regexp.MustCompile(`(?i)((?:x-api-key|api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*)\S+`)
)

// redactSecrets scrubs credential-shaped substrings from diagnostics.
func redactSecrets(value string, maxLength int) string {
	result := patternAuth.ReplaceAllString(value, "$1[REDACTED]")
	result = patternSecrets.ReplaceAllString(result, "$1[REDACTED]")
	if len(result) <= maxLength {
		return result
	}
	return result[:maxLength-3] + "..."
}

// formatCliError mirrors the Node classifier so Agents see stable guidance.
func formatCliError(err error) string {
	message := redactSecrets(err.Error(), 2000)
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "authentication required") ||
		strings.Contains(lower, "not logged in"):
		return "Harness authentication is required. Authenticate the selected Harness locally, then retry."
	case strings.Contains(message, "ENOENT") ||
		strings.Contains(lower, "not found") ||
		spawnFailed(lower):
		return "Harness launcher is unavailable. Run `free4chat-agent doctor` and retry."
	case strings.Contains(message, "room_expired"):
		return "The Free4Chat room has expired. Copy a new invite and retry."
	case strings.Contains(message, "ACP process exited") ||
		strings.Contains(message, "ACP session is unavailable"):
		return "The Harness ACP process stopped before joining. Run `free4chat-agent doctor` and retry."
	}
	if len(message) > 300 {
		return message[:297] + "..."
	}
	return message
}

func spawnFailed(lower string) bool {
	if !strings.Contains(lower, "spawn ") || !strings.Contains(lower, " failed") {
		return false
	}
	return true
}
