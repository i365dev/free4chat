package cli

import (
	"strings"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/daemon"
)

/*
 * `free4chat-agent handoff` (#409, V1) CLI composition.
 *
 * The command is a thin local shell over the daemon IPC ops: it must send the
 * exact request for the selected mode, print only what the daemon returned, and
 * fail with the usage error (exit 2) when the operator's selection is
 * ambiguous. The ACP session id travels in the operator's own local command and
 * is never echoed back into the terminal output.
 */

// handoffFixture serves the daemon-side envelope for handoff ops.
func handoffFixture(t *testing.T) *fakeDaemon {
	t.Helper()
	return newFakeDaemon(t, func(request daemon.IpcRequest) daemon.IpcResponse {
		switch request.Op {
		case "status":
			// EnsureDaemon's liveness probe: an existing daemon answers it.
			return daemon.IpcResponse{OK: true, Result: []any{}}
		case "handoff-adopt":
			return daemon.IpcResponse{OK: true, Result: map[string]any{
				"state": "armed", "armed": true, "humanParticipantId": "human-1",
			}}
		case "handoff-state":
			return daemon.IpcResponse{OK: true, Result: map[string]any{
				"armed": true, "humanParticipantId": "human-1",
			}}
		case "handoff-clear":
			return daemon.IpcResponse{OK: true, Result: map[string]any{"state": "cleared"}}
		case "handoff-list":
			return daemon.IpcResponse{OK: true, Result: map[string]any{
				"sessions": []any{map[string]any{
					"SessionID": "native-pi-1", "Cwd": "/workspace/project",
					"Title": "Native Pi conversation", "UpdatedAt": "2026-09-19T10:00:00Z",
				}},
				"nextCursor": "",
			}}
		default:
			return daemon.IpcResponse{OK: true, Result: map[string]any{}}
		}
	})
}

// nextHandoffRequest skips the daemon liveness probe and returns the first
// request that is actually the handoff op under test.
func nextHandoffRequest(t *testing.T, fixture *fakeDaemon) daemon.IpcRequest {
	t.Helper()
	for attempt := 0; attempt < 4; attempt++ {
		request := nextFakeRequest(t, fixture)
		if request.Op != "status" {
			return request
		}
	}
	t.Fatal("no handoff request reached the daemon")
	return daemon.IpcRequest{}
}

func TestHandoffAdoptSendsTheExactLocalRequest(t *testing.T) {
	fixture := handoffFixture(t)
	output, code := runCliWithFakeDaemon(t, fixture, "handoff",
		"--adopt", "native-pi-1",
		"--instance", "pi-1",
		"--cwd", "/workspace/project",
		"--human", "human-1")
	if code != 0 {
		t.Fatalf("handoff --adopt exited %d: %s", code, output)
	}
	request := nextHandoffRequest(t, fixture)
	if request.Op != "handoff-adopt" || request.InstanceID != "pi-1" ||
		request.SessionID != "native-pi-1" || request.SessionCwd != "/workspace/project" ||
		request.HumanParticipantID != "human-1" {
		t.Fatalf("handoff --adopt request mismatch: %#v", request)
	}
	// The terminal shows the bounded local state, never the ACP identity it
	// just sent.
	if !strings.Contains(output, `"armed": true`) || !strings.Contains(output, `"humanParticipantId": "human-1"`) {
		t.Fatalf("handoff --adopt output mismatch: %s", output)
	}
	if strings.Contains(output, "native-pi-1") {
		t.Fatalf("the session id was echoed into terminal output: %s", output)
	}
}

func TestHandoffListSendsDiscoveryBoundsAndPrintsDescriptors(t *testing.T) {
	fixture := handoffFixture(t)
	output, code := runCliWithFakeDaemon(t, fixture, "handoff",
		"--list", "--instance", "pi-1", "--cwd", "/workspace/project", "--cursor", "page-2")
	if code != 0 {
		t.Fatalf("handoff --list exited %d: %s", code, output)
	}
	request := nextHandoffRequest(t, fixture)
	if request.Op != "handoff-list" || request.InstanceID != "pi-1" ||
		request.SessionCwd != "/workspace/project" || request.SessionCursor != "page-2" {
		t.Fatalf("handoff --list request mismatch: %#v", request)
	}
	if !strings.Contains(output, "native-pi-1") || !strings.Contains(output, "Native Pi conversation") {
		t.Fatalf("handoff --list did not print the descriptors: %s", output)
	}
}

func TestHandoffStatusAndClearUseTheExistingLocalOps(t *testing.T) {
	fixture := handoffFixture(t)
	output, code := runCliWithFakeDaemon(t, fixture, "handoff", "--status", "--instance", "pi-1")
	if code != 0 {
		t.Fatalf("handoff --status exited %d: %s", code, output)
	}
	if request := nextHandoffRequest(t, fixture); request.Op != "handoff-state" || request.InstanceID != "pi-1" {
		t.Fatalf("handoff --status request mismatch: %#v", request)
	}
	if !strings.Contains(output, `"armed": true`) {
		t.Fatalf("handoff --status output mismatch: %s", output)
	}

	output, code = runCliWithFakeDaemon(t, fixture, "handoff", "--clear", "--instance", "pi-1")
	if code != 0 {
		t.Fatalf("handoff --clear exited %d: %s", code, output)
	}
	if request := nextHandoffRequest(t, fixture); request.Op != "handoff-clear" || request.InstanceID != "pi-1" {
		t.Fatalf("handoff --clear request mismatch: %#v", request)
	}
	if !strings.Contains(output, `"state": "cleared"`) {
		t.Fatalf("handoff --clear output mismatch: %s", output)
	}
}

func TestHandoffRequiresExactlyOneLocalSelection(t *testing.T) {
	for name, args := range map[string][]string{
		"no selection":       {"handoff"},
		"two selections":     {"handoff", "--list", "--status"},
		"adopt plus clear":   {"handoff", "--adopt", "native-1", "--clear"},
		"empty adopt value":  {"handoff", "--adopt", "   "},
		"unknown subcommand": {"handoff", "--teleport"},
	} {
		output, code := runCli(t, args...)
		if code != 2 {
			t.Fatalf("%s: expected usage exit 2, got %d (%s)", name, code, output)
		}
		if !strings.Contains(output, "handoff") {
			t.Fatalf("%s: usage text did not mention handoff: %s", name, output)
		}
	}
}

// TestHandoffAdoptNeverRepairsTheSessionIdentity pins the local transport
// contract: the CLI forwards the operator's session id exactly as typed (the
// Runtime/adapter validate it), and only a value that carries no identity at
// all is refused as a usage error.
func TestHandoffAdoptNeverRepairsTheSessionIdentity(t *testing.T) {
	fixture := handoffFixture(t)
	const padded = " native-pi-1 "
	output, code := runCliWithFakeDaemon(t, fixture, "handoff", "--adopt", padded, "--instance", "pi-1")
	if code != 0 {
		t.Fatalf("handoff --adopt exited %d: %s", code, output)
	}
	if request := nextHandoffRequest(t, fixture); request.SessionID != padded {
		t.Fatalf("the CLI repaired the opaque session id: %q", request.SessionID)
	}
}
