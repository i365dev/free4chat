package cli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode"

	"github.com/i365dev/free4chat/agent/internal/daemon"
	"github.com/i365dev/free4chat/agent/internal/doctor"
)

var binaryPath string

// TestMain builds the real free4chat-agent binary once: the routing
// regression guard (#105 review) pins dispatcher behavior via subprocess
// exits, which requires the actual executable.
//
// After the suite it also enforces the #172 leak invariant: ZERO daemon
// process spawned by these tests may survive. The scan is keyed on the full
// unique build path, so it can only ever observe processes from THIS test
// run — the user's canonical ~/.free4chat-agent daemon can never match.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fcagent-cli-")
	if err != nil {
		panic(err)
	}
	bin := filepath.Join(dir, "free4chat-agent")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/free4chat-agent")
	if out, err := build.CombinedOutput(); err != nil {
		panic("binary build failed: " + string(out))
	}
	binaryPath = bin
	code := m.Run()
	leaked := waitForNoTestDaemons(5 * time.Second)
	if len(leaked) > 0 {
		fmt.Fprintf(os.Stderr,
			"\nFAIL: %d detached free4chat-agent daemon(s) leaked from CLI tests (owned by %s):\n",
			len(leaked), bin)
		for _, provenance := range leaked {
			fmt.Fprintln(os.Stderr, "  "+provenance)
		}
		if code == 0 {
			code = 1
		}
	}
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// testDaemonProcs lists "PID command" lines for every process whose command
// line contains this run's built binary path. pgrep exits 1 on "no match",
// which is the healthy empty case.
func testDaemonProcs() ([]string, error) {
	out, err := exec.Command("pgrep", "-f", regexp.QuoteMeta(binaryPath)).Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, err
	}
	var provenance []string
	for _, pid := range strings.Fields(string(out)) {
		command, procErr := exec.Command("ps", "-p", pid, "-o", "command=").Output()
		if procErr != nil {
			// The process may have exited between pgrep and ps: it is gone,
			// which is the desired state.
			continue
		}
		provenance = append(provenance, strings.TrimSpace(pid+" "+string(command)))
	}
	return provenance, nil
}

// waitForNoTestDaemons polls until no test-owned daemon process remains and
// returns whatever still survives when the deadline passes.
func waitForNoTestDaemons(timeout time.Duration) []string {
	deadline := time.Now().Add(timeout)
	for {
		procs, err := testDaemonProcs()
		if err == nil && len(procs) == 0 {
			return nil
		}
		if err != nil {
			// The process scan itself is unavailable (no pgrep/ps): degrade
			// to a warning instead of a false failure.
			fmt.Fprintf(os.Stderr, "warning: daemon leak scan unavailable: %v\n", err)
			return nil
		}
		if time.Now().After(deadline) {
			return procs
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// withAgentDir scopes FREE4CHAT_AGENT_DIR for one helper call and always
// restores the previous environment.
func withAgentDir(dir string, fn func()) {
	previous, had := os.LookupEnv("FREE4CHAT_AGENT_DIR")
	_ = os.Setenv("FREE4CHAT_AGENT_DIR", dir)
	defer func() {
		if had {
			_ = os.Setenv("FREE4CHAT_AGENT_DIR", previous)
		} else {
			_ = os.Unsetenv("FREE4CHAT_AGENT_DIR")
		}
	}()
	fn()
}

// daemonReachable reports whether a daemon answers a status probe on this
// runtime directory's socket.
func daemonReachable(dir string) bool {
	reachable := false
	withAgentDir(dir, func() {
		_, err := daemon.SendIPC(&daemon.IpcRequest{Op: "status"})
		reachable = err == nil
	})
	return reachable
}

// stopTestDaemon reclaims the daemon owned by THIS test's runtime directory
// (#172): it uses the daemon's own stop op over IPC — never a signal or
// pattern kill — and then waits deterministically until the socket stops
// answering, which the daemon guarantees during its own shutdown. A daemon
// that was never spawned for this directory is a no-op.
func stopTestDaemon(t *testing.T, dir string) {
	t.Helper()
	if !daemonReachable(dir) {
		return
	}
	withAgentDir(dir, func() {
		_, _ = daemon.SendIPC(&daemon.IpcRequest{Op: "stop"})
	})
	deadline := time.Now().Add(5 * time.Second)
	for daemonReachable(dir) {
		if time.Now().After(deadline) {
			t.Errorf("test daemon in %s kept its IPC socket after the stop op", dir)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func runCli(t *testing.T, args ...string) (string, int) {
	t.Helper()
	dir, err := os.MkdirTemp("", "fcagent-")
	if err != nil {
		t.Fatalf("temp dir failed: %v", err)
	}
	// #172: any invocation that routes through the daemon (status, leave,
	// stop, ...) auto-starts a detached daemon in this unique directory via
	// EnsureDaemon. Reclaim exactly that daemon during cleanup — production
	// detach semantics stay untouched, and no other daemon can ever match.
	// Stop MUST happen before the directory removal (socket lives in it).
	t.Cleanup(func() {
		stopTestDaemon(t, dir)
		_ = os.RemoveAll(dir)
	})
	cmd := exec.Command(binaryPath, args...)
	cmd.Env = append(os.Environ(),
		"FREE4CHAT_AGENT_DIR="+dir,
		"FREE4CHAT_TEST_DISABLE_NATIVE_CREDENTIAL_STORE=1",
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.Output()
	out := string(stdout) + stderr.String()
	if err == nil {
		return out, 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return out, exitErr.ExitCode()
	}
	t.Fatalf("cli run failed: %v", err)
	return out, -1
}

// fakeDaemon is a small IPC-only fixture for CLI composition tests. It speaks
// the existing daemon envelope and records operations, so these tests prove
// the room namespace does not invent a second daemon protocol.
type fakeDaemon struct {
	dir      string
	listener net.Listener
	requests chan daemon.IpcRequest
	response func(daemon.IpcRequest) daemon.IpcResponse
}

func newFakeDaemon(t *testing.T, response func(daemon.IpcRequest) daemon.IpcResponse) *fakeDaemon {
	t.Helper()
	// Unix socket paths on macOS have a small fixed maximum. t.TempDir()
	// includes the full test name, which can exceed it; use the same short
	// temporary-directory pattern as the subprocess helper above.
	dir, err := os.MkdirTemp("", "fcagent-fake-")
	if err != nil {
		t.Fatalf("fake daemon temp directory failed: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	listener, err := net.Listen("unix", filepath.Join(dir, "daemon.sock"))
	if err != nil {
		t.Fatalf("fake daemon listen failed: %v", err)
	}
	fixture := &fakeDaemon{
		dir:      dir,
		listener: listener,
		requests: make(chan daemon.IpcRequest, 16),
		response: response,
	}
	t.Cleanup(func() { _ = listener.Close() })
	go fixture.serve()
	return fixture
}

func (d *fakeDaemon) serve() {
	for {
		conn, err := d.listener.Accept()
		if err != nil {
			return
		}
		go d.serveOne(conn)
	}
}

func (d *fakeDaemon) serveOne(conn net.Conn) {
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return
	}
	request, err := daemon.DecodeRequest([]byte(strings.TrimSpace(line)))
	if err != nil {
		return
	}
	d.requests <- *request
	response, err := json.Marshal(d.response(*request))
	if err == nil {
		_, _ = conn.Write(append(response, '\n'))
	}
}

func runCliWithFakeDaemon(t *testing.T, fixture *fakeDaemon, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(binaryPath, args...)
	cmd.Env = append(os.Environ(),
		"FREE4CHAT_AGENT_DIR="+fixture.dir,
		"FREE4CHAT_TEST_DISABLE_NATIVE_CREDENTIAL_STORE=1",
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.Output()
	output := string(stdout) + stderr.String()
	if err == nil {
		return output, 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return output, exitErr.ExitCode()
	}
	t.Fatalf("CLI run against fake daemon failed: %v", err)
	return output, -1
}

func nextFakeRequest(t *testing.T, fixture *fakeDaemon) daemon.IpcRequest {
	t.Helper()
	select {
	case request := <-fixture.requests:
		return request
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for fake daemon request")
		return daemon.IpcRequest{}
	}
}

func TestContextReadPreservesExplicitZeroCursorPresenceOverIPC(t *testing.T) {
	fixture := newFakeDaemon(t, func(request daemon.IpcRequest) daemon.IpcResponse {
		if request.Op == "status" {
			return daemon.IpcResponse{OK: true, Result: []any{}}
		}
		return daemon.IpcResponse{OK: true, Result: map[string]any{}}
	})
	_, code := runCliWithFakeDaemon(t, fixture, "context", "read",
		"--before-sequence", "0", "--after-sequence", "0",
		"--before-transcript-sequence", "0", "--after-transcript-sequence", "0")
	if code != 0 {
		t.Fatalf("context read with explicit zero cursors exited %d", code)
	}
	if status := nextFakeRequest(t, fixture); status.Op != "status" {
		t.Fatalf("context read preflight = %q, want status", status.Op)
	}
	request := nextFakeRequest(t, fixture)
	for name, cursor := range map[string]*int64{
		"beforeSequence": request.BeforeSequence, "afterSequence": request.AfterSequence,
		"beforeTranscriptSequence": request.BeforeTranscriptSequence,
		"afterTranscriptSequence":  request.AfterTranscriptSequence,
	} {
		if cursor == nil || *cursor != 0 {
			t.Fatalf("explicit zero %s was lost over IPC: %#v", name, request)
		}
	}

	_, code = runCliWithFakeDaemon(t, fixture, "context", "read")
	if code != 0 {
		t.Fatalf("context read without cursors exited %d", code)
	}
	if status := nextFakeRequest(t, fixture); status.Op != "status" {
		t.Fatalf("context read preflight = %q, want status", status.Op)
	}
	request = nextFakeRequest(t, fixture)
	if request.BeforeSequence != nil || request.AfterSequence != nil ||
		request.BeforeTranscriptSequence != nil || request.AfterTranscriptSequence != nil {
		t.Fatalf("omitted context cursors were sent over IPC: %#v", request)
	}
}

func roomFixture(t *testing.T, createResult, joinResult json.RawMessage) *fakeDaemon {
	t.Helper()
	return newFakeDaemon(t, func(request daemon.IpcRequest) daemon.IpcResponse {
		switch request.Op {
		case "status":
			return daemon.IpcResponse{OK: true, Result: []any{}}
		case "daemon-info":
			return daemon.IpcResponse{OK: true, Result: daemon.DaemonInfo{DaemonVersion: doctor.Version}}
		case "create":
			return daemon.IpcResponse{OK: true, Result: createResult}
		case "join":
			return daemon.IpcResponse{OK: true, Result: joinResult}
		default:
			return daemon.IpcResponse{OK: false, Error: "unexpected fake daemon operation"}
		}
	})
}

// TestTestDaemonStopIsScopedAndDeterministic pins the reclaim contract the
// whole suite relies on: the daemon's own stop op tears down the socket and
// then the process, without any signal or pattern kill, and nothing else is
// affected.
func TestTestDaemonStopIsScopedAndDeterministic(t *testing.T) {
	dir, err := os.MkdirTemp("", "fcagent-")
	if err != nil {
		t.Fatalf("temp dir failed: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	command := exec.Command(binaryPath, "daemon")
	command.Env = append(os.Environ(),
		"FREE4CHAT_AGENT_DIR="+dir,
		"FREE4CHAT_TEST_DISABLE_NATIVE_CREDENTIAL_STORE=1",
	)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatalf("daemon spawn failed: %v", err)
	}
	exited := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(exited)
	}()
	// Safety net so a mid-test failure cannot leak the daemon past the
	// TestMain invariant scan.
	t.Cleanup(func() {
		_ = command.Process.Kill()
		<-exited
	})

	deadline := time.Now().Add(5 * time.Second)
	for !daemonReachable(dir) {
		if time.Now().After(deadline) {
			t.Fatalf("test daemon never answered on its socket")
		}
		time.Sleep(20 * time.Millisecond)
	}

	stopTestDaemon(t, dir)

	if daemonReachable(dir) {
		t.Fatalf("socket must stop answering after the daemon's own stop op")
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatalf("daemon process must exit after its stop op")
	}
}

func TestCliRoutingNeverFallsThroughSilently(t *testing.T) {
	for _, args := range [][]string{
		{"status"},
		{"leave", "some-instance"},
		{"stop"},
	} {
		output, code := runCli(t, args...)
		if strings.TrimSpace(output) == "" {
			t.Fatalf("cli %v produced no output", args)
		}
		if code != 0 {
			t.Fatalf("cli %v exited %d: %s", args, code, output)
		}
	}
}

func TestCreateRejectsRoomFlagAndMissingLauncher(t *testing.T) {
	for _, args := range [][]string{
		{"create", "--room", "some-room", "--agent", "opencode", "--name", "A"},
		{"create", "--name", "A"},
		{"create", "--agent", "opencode"},
		{"create", "--agent", "opencode", "--agent-command", "x", "--name", "A"},
	} {
		output, code := runCli(t, args...)
		if code != 2 {
			t.Fatalf("create %v should usage()-exit with 2, got %d (%q)", args, code, output)
		}
		if !strings.Contains(output, "free4chat-agent create") {
			t.Fatalf("usage text must mention the command: %q", output)
		}
	}
}

func TestRoomCommandsReuseCreateAndJoinDaemonOperations(t *testing.T) {
	createResult := json.RawMessage(`{
  "state":"waiting",
  "roomId":"room-created",
  "name":"Pi",
  "invite":{"kind":"free4chat.room-invite","version":1,"roomId":"room-created","roomUrl":"https://www.free4.chat/room?id=room-created"}
}`)
	joinResult := json.RawMessage(`{
  "state":"waiting",
  "roomId":"room-created",
  "name":"Codex"
}`)
	fixture := roomFixture(t, createResult, joinResult)

	createOutput, createCode := runCliWithFakeDaemon(t, fixture,
		"room", "create", "--agent", "pi", "--name", "Pi", "--capability", "code.edit")
	if createCode != 0 {
		t.Fatalf("room create failed: %d %q", createCode, createOutput)
	}
	if !strings.Contains(createOutput, "Created temporary Room") ||
		!strings.Contains(createOutput, "Pi joined") ||
		!strings.Contains(createOutput, "Room: room-created") ||
		!strings.Contains(createOutput, "Human UI: https://www.free4.chat/room?id=room-created") {
		t.Fatalf("room create human output mismatch: %q", createOutput)
	}
	if request := nextFakeRequest(t, fixture); request.Op != "status" {
		t.Fatalf("room create must retain normal daemon readiness check, got %+v", request)
	}
	createRequest := nextFakeRequest(t, fixture)
	if createRequest.Op != "create" || createRequest.Room != "" ||
		createRequest.Agent != "pi" || createRequest.Name != "Pi" ||
		!reflect.DeepEqual(createRequest.Capabilities, []string{"code.edit"}) {
		t.Fatalf("room create must submit the legacy create request, got %+v", createRequest)
	}

	joinOutput, joinCode := runCliWithFakeDaemon(t, fixture,
		"room", "join", "room-created", "--agent", "codex", "--name", "Codex", "--capability", "shell")
	if joinCode != 0 {
		t.Fatalf("room join failed: %d %q", joinCode, joinOutput)
	}
	if !strings.Contains(joinOutput, "Codex joined") ||
		!strings.Contains(joinOutput, "Room: room-created") {
		t.Fatalf("room join human output mismatch: %q", joinOutput)
	}
	if request := nextFakeRequest(t, fixture); request.Op != "daemon-info" {
		t.Fatalf("room join must retain daemon version handshake, got %+v", request)
	}
	joinRequest := nextFakeRequest(t, fixture)
	if joinRequest.Op != "join" || joinRequest.Room != "room-created" ||
		joinRequest.Agent != "codex" || joinRequest.Name != "Codex" ||
		!reflect.DeepEqual(joinRequest.Capabilities, []string{"shell"}) {
		t.Fatalf("room join must submit the legacy join request, got %+v", joinRequest)
	}
}

func TestRoomJoinPreservesCustomLauncherAndAllowsMultipleLocalResidents(t *testing.T) {
	joinResult := json.RawMessage(`{"state":"waiting","roomId":"shared-room"}`)
	fixture := roomFixture(t, json.RawMessage(`{}`), joinResult)

	for _, command := range [][]string{
		{"room", "join", "shared-room", "--agent-command", "custom-acp", "--agent-arg", "--stdio", "--agent-arg", "json", "--name", "Custom"},
		{"room", "join", "shared-room", "--agent", "hermes", "--name", "Hermes"},
	} {
		output, code := runCliWithFakeDaemon(t, fixture, command...)
		if code != 0 {
			t.Fatalf("%v failed: %d %q", command, code, output)
		}
		if request := nextFakeRequest(t, fixture); request.Op != "daemon-info" {
			t.Fatalf("room join must use the existing daemon handshake, got %+v", request)
		}
		request := nextFakeRequest(t, fixture)
		if request.Op != "join" || request.Room != "shared-room" {
			t.Fatalf("room join must not impose a team/group restriction, got %+v", request)
		}
		if request.AgentCommand == "custom-acp" && !reflect.DeepEqual(request.AgentArgs, []string{"--stdio", "json"}) {
			t.Fatalf("custom launcher arguments changed: %+v", request)
		}
	}
}

func TestRoomHumanOutputExcludesDaemonPrivateFields(t *testing.T) {
	createResult := json.RawMessage(`{
  "roomId":"safe-room",
  "participantId":"participant-visible-but-unneeded",
  "participantHandle":"participant-handle-private",
  "participantToken":"participant-token-private",
  "runtimeProviderHandle":"provider-handle-private",
  "providerClaim":"provider-claim-private",
  "runtimeProviderProof":"provider-proof-private",
  "sfuSessionId":"sfu-session-private",
  "internalSecret":"internal-secret-private",
  "invite":{"kind":"free4chat.room-invite","version":1,"roomId":"safe-room","roomUrl":"https://www.free4.chat/room?id=safe-room"}
}`)
	joinResult := json.RawMessage(`{
  "roomId":"safe-room",
  "participantId":"participant-visible-but-unneeded",
  "participantHandle":"participant-handle-private",
  "participantToken":"participant-token-private",
  "runtimeProviderHandle":"provider-handle-private",
  "providerClaim":"provider-claim-private",
  "runtimeProviderProof":"provider-proof-private",
  "sfuSessionId":"sfu-session-private",
  "internalSecret":"internal-secret-private"
}`)
	fixture := roomFixture(t, createResult, joinResult)

	createOutput, createCode := runCliWithFakeDaemon(t, fixture,
		"room", "create", "--agent", "pi", "--name", "Pi")
	if createCode != 0 {
		t.Fatalf("room create failed: %d %q", createCode, createOutput)
	}
	joinOutput, joinCode := runCliWithFakeDaemon(t, fixture,
		"room", "join", "safe-room", "--agent", "codex", "--name", "Codex")
	if joinCode != 0 {
		t.Fatalf("room join failed: %d %q", joinCode, joinOutput)
	}
	for _, output := range []string{createOutput, joinOutput} {
		for _, private := range []string{
			"participant-handle-private", "participant-token-private", "provider-handle-private",
			"provider-claim-private", "provider-proof-private", "sfu-session-private", "internal-secret-private",
			"participant-visible-but-unneeded", "{\"roomId\"",
		} {
			if strings.Contains(output, private) {
				t.Fatalf("human-facing room output leaked %q: %q", private, output)
			}
		}
	}
}

func TestTerminalSafeEscapesTerminalControls(t *testing.T) {
	input := "safe\n\r\t\x00\x1b\x7f\u009b"
	if got, want := terminalSafe(input), `safe\n\r\t\x00\x1b\x7f\x9b`; got != want {
		t.Fatalf("terminal-safe output mismatch:\n got: %q\nwant: %q", got, want)
	}
	for _, runeValue := range terminalSafe(input) {
		if unicode.IsControl(runeValue) {
			t.Fatalf("terminal-safe output retained control rune %U", runeValue)
		}
	}
}

func TestRoomHumanOutputEscapesTerminalControls(t *testing.T) {
	roomID := "safe\nFORGED\rROW\u009b2J"
	name := "\x1b[31mPi\t"
	createResult := json.RawMessage(`{
  "invite":{"kind":"free4chat.room-invite","version":1,"roomId":"safe\nFORGED\rROW\u009b2J","roomUrl":"https://www.free4.chat/room?id=safe%0A\u001b]8;;https://attacker.example\u0007"}
}`)
	joinResult := json.RawMessage(`{"state":"waiting","roomId":"safe\nFORGED\rROW\u009b2J"}`)
	fixture := roomFixture(t, createResult, joinResult)

	createOutput, createCode := runCliWithFakeDaemon(t, fixture,
		"room", "create", "--agent", "pi", "--name", name)
	if createCode != 0 {
		t.Fatalf("room create failed: %d %q", createCode, createOutput)
	}
	joinOutput, joinCode := runCliWithFakeDaemon(t, fixture,
		"room", "join", roomID, "--agent", "codex", "--name", name)
	if joinCode != 0 {
		t.Fatalf("room join failed: %d %q", joinCode, joinOutput)
	}

	for _, output := range []string{createOutput, joinOutput} {
		for _, runeValue := range []rune{'\x00', '\r', '\t', '\x1b', '\x7f', '\u009b'} {
			if strings.ContainsRune(output, runeValue) {
				t.Fatalf("human-facing room output retained control rune %U: %q", runeValue, output)
			}
		}
		if strings.Contains(output, "safe\nFORGED") {
			t.Fatalf("human-facing room output allowed a forged line: %q", output)
		}
	}
	for _, expected := range []string{
		"✓ \\x1b[31mPi\\t joined",
		"Room: safe\\nFORGED\\rROW\\x9b2J",
	} {
		if !strings.Contains(createOutput, expected) || !strings.Contains(joinOutput, expected) {
			t.Fatalf("room output omitted escaped public value %q:\ncreate: %q\njoin: %q", expected, createOutput, joinOutput)
		}
	}
	if !strings.Contains(createOutput, "Human UI: https://www.free4.chat/room?id=safe%0A\\x1b]8;;https://attacker.example\\x07") {
		t.Fatalf("room create did not escape the public Room URL: %q", createOutput)
	}
}

func TestRoomCommandsKeepLegacyMachineReadableOutput(t *testing.T) {
	createResult := json.RawMessage(`{"state":"waiting","roomId":"legacy-room","name":"Pi","instanceId":"instance-a","participantId":"participant-a","invite":{"kind":"free4chat.room-invite","version":1,"roomId":"legacy-room","roomUrl":"https://www.free4.chat/room?id=legacy-room"}}`)
	joinResult := json.RawMessage(`{"state":"waiting","roomId":"legacy-room","name":"Codex","instanceId":"instance-b","participantId":"participant-b"}`)
	fixture := roomFixture(t, createResult, joinResult)

	for _, test := range []struct {
		args     []string
		expected json.RawMessage
	}{
		{[]string{"create", "--agent", "pi", "--name", "Pi"}, createResult},
		{[]string{"join", "--room", "legacy-room", "--agent", "codex", "--name", "Codex"}, joinResult},
	} {
		output, code := runCliWithFakeDaemon(t, fixture, test.args...)
		if code != 0 {
			t.Fatalf("legacy %v failed: %d %q", test.args, code, output)
		}
		var got, want any
		if err := json.Unmarshal([]byte(output), &got); err != nil {
			t.Fatalf("legacy %v stopped returning JSON: %v (%q)", test.args, err, output)
		}
		if err := json.Unmarshal(test.expected, &want); err != nil {
			t.Fatalf("bad expected fixture: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("legacy %v response changed:\n got: %#v\nwant: %#v", test.args, got, want)
		}
	}
}

func TestRoomRejectsInvalidCommandShapesAndMalformedDaemonOutput(t *testing.T) {
	for _, args := range [][]string{
		{"room"},
		{"room", "create", "--room", "not-allowed", "--agent", "pi", "--name", "Pi"},
		{"room", "join", "--room", "not-allowed", "--agent", "pi", "--name", "Pi"},
		{"room", "join", "safe-room", "--room", "not-allowed", "--agent", "pi", "--name", "Pi"},
		{"room", "join", "safe-room", "--name", "Pi"},
		{"room", "unknown"},
	} {
		output, code := runCli(t, args...)
		if code != 2 || !strings.Contains(output, "free4chat-agent room") {
			t.Fatalf("room %v must usage-exit without a daemon request: code=%d output=%q", args, code, output)
		}
	}

	fixture := roomFixture(t,
		json.RawMessage(`{"participantHandle":"malformed-response-private"}`),
		json.RawMessage(`{"participantHandle":"malformed-response-private"}`),
	)
	output, code := runCliWithFakeDaemon(t, fixture,
		"room", "create", "--agent", "pi", "--name", "Pi")
	if code != 1 || !strings.Contains(output, "omitted the public Room invite") ||
		strings.Contains(output, "malformed-response-private") {
		t.Fatalf("malformed create response must fail closed without echoing private fields: code=%d output=%q", code, output)
	}
}

func TestUsageAndUnknownCommandsExitTwo(t *testing.T) {
	if _, code := runCli(t); code != 2 {
		t.Fatalf("bare invocation should exit 2")
	}
	if _, code := runCli(t, "teleport"); code != 2 {
		t.Fatal("unknown command should exit 2")
	}
	if _, code := runCli(t, "peers"); code != 2 {
		t.Fatal("peers without --room should exit 2")
	}
	if _, code := runCli(t, "join"); code != 2 {
		t.Fatal("malformed join should exit 2")
	}
}

func TestDoctorHumanAndJsonOutputs(t *testing.T) {
	output, code := runCli(t, "doctor")
	if code != 0 || !strings.Contains(output, "Launchers:") ||
		!strings.Contains(output, "hermes") {
		t.Fatalf("doctor text mismatch: %q", output)
	}
	jsonOutput, code := runCli(t, "doctor", "--json")
	if code != 0 {
		t.Fatalf("doctor --json failed: %q", jsonOutput)
	}
	var report struct {
		Package   string `json:"package"`
		Runtime   string `json:"runtime"`
		Launchers []struct {
			ID    string `json:"id"`
			Ready bool   `json:"ready"`
		} `json:"launchers"`
	}
	if err := json.Unmarshal([]byte(jsonOutput), &report); err != nil ||
		report.Runtime != "go" ||
		len(report.Launchers) == 0 || report.Launchers[0].ID != "hermes" {
		t.Fatalf("doctor json mismatch: %q %v", jsonOutput, err)
	}
}

func TestVersionReportsStableLocalMachineReadableValue(t *testing.T) {
	jsonOutput, code := runCli(t, "version", "--json")
	if code != 0 {
		t.Fatalf("version --json failed: %q", jsonOutput)
	}
	var report struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(jsonOutput), &report); err != nil {
		t.Fatalf("version JSON parse failed: %v (%q)", err, jsonOutput)
	}
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(report.Version) {
		t.Fatalf("version is not stable semantic version: %q", report.Version)
	}
	if strings.Contains(jsonOutput, "FREE4CHAT_AGENT_DIR") ||
		strings.Contains(jsonOutput, "free4chat-agent-") {
		t.Fatalf("version output leaked local details: %q", jsonOutput)
	}

	textOutput, code := runCli(t, "version")
	if code != 0 || strings.TrimSpace(textOutput) != report.Version {
		t.Fatalf("human version output mismatch: code=%d output=%q", code, textOutput)
	}
}

func TestReadinessReportsGoRuntimeAndDeferredMedia(t *testing.T) {
	output, code := runCli(t, "readiness", "--json")
	if code != 0 {
		t.Fatalf("readiness failed: %q", output)
	}
	var report struct {
		Runtime struct {
			Ready   bool   `json:"ready"`
			Runtime string `json:"runtime"`
		} `json:"runtime"`
		Media struct {
			Engine    string `json:"engine"`
			Supported bool   `json:"supported"`
			Ready     bool   `json:"ready"`
		} `json:"media"`
		Speech struct {
			STT struct {
				Provider   string `json:"provider"`
				Configured bool   `json:"configured"`
				Ready      bool   `json:"ready"`
			} `json:"stt"`
			TTS struct {
				Provider   string `json:"provider"`
				Configured bool   `json:"configured"`
				Ready      bool   `json:"ready"`
			} `json:"tts"`
		} `json:"speech"`
	}
	if err := json.Unmarshal([]byte(output), &report); err != nil {
		t.Fatalf("readiness parse failed: %v (%q)", err, output)
	}
	if !report.Runtime.Ready || report.Runtime.Runtime != "go" {
		t.Fatalf("go runtime readiness wrong: %+v", report.Runtime)
	}
	// Media is real now (in-process Pion), but speech readiness must stay
	// honest about the LOCAL provider configuration — never about a room
	// grant (that is room state, checked by the controller at grant time).
	if !report.Media.Supported || !report.Media.Ready || report.Media.Engine != "pion" {
		t.Fatalf("in-process Pion media must be reported available: %+v", report.Media)
	}
	if report.Speech.STT.Provider != "doubao" || report.Speech.TTS.Provider != "doubao" {
		t.Fatalf("doubao is the only production provider: %+v", report.Speech)
	}
	// No DOUBAO_API_KEY in the test environment: configuration must be
	// reported false, and text readiness must still hold (it does — the
	// report was produced at all).
	if report.Speech.STT.Configured || report.Speech.STT.Ready {
		t.Fatalf("STT must not claim readiness without a credential: %+v", report.Speech.STT)
	}
	if report.Speech.TTS.Configured || report.Speech.TTS.Ready {
		t.Fatalf("TTS must not claim readiness without a credential: %+v", report.Speech.TTS)
	}
}

func TestStatusPayloadShowsResidentAfterDaemonAutoStart(t *testing.T) {
	// status/ensureDaemon spawns the detached daemon; then readiness --room
	// projects not_joined for an unrelated room (bounded local state check).
	output, code := runCli(t, "status")
	if code != 0 || !strings.Contains(strings.TrimSpace(output), "[") {
		t.Fatalf("status payload mismatch: %q", output)
	}
	roomView, code := runCli(t, "readiness", "--json", "--room", "unjoined-room")
	_ = roomView
	if code != 0 || !strings.Contains(roomView, `"reason": "not_joined"`) &&
		!strings.Contains(roomView, `"reason":"not_joined"`) {
		t.Fatalf("room readiness mismatch: %q", roomView)
	}
}

func TestRunViaDaemonRejectsStaleResidentBeforeJoin(t *testing.T) {
	dir, err := os.MkdirTemp("", "fcagent-")
	if err != nil {
		t.Fatalf("temp dir failed: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)
	listener, err := net.Listen("unix", daemon.SocketPath())
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	operations := make(chan string, 2)
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			func() {
				defer conn.Close()
				line, readErr := bufio.NewReader(conn).ReadString('\n')
				if readErr != nil {
					return
				}
				var request struct {
					Op string `json:"op"`
				}
				if json.Unmarshal([]byte(strings.TrimSpace(line)), &request) != nil {
					return
				}
				operations <- request.Op
				response, marshalErr := json.Marshal(daemon.IpcResponse{
					OK: true,
					Result: daemon.DaemonInfo{
						DaemonVersion: "0.5.3",
					},
				})
				if marshalErr == nil {
					_, _ = conn.Write(append(response, '\n'))
				}
			}()
		}
	}()

	err = runViaDaemon(&daemon.IpcRequest{Op: "join"})
	if err == nil || !strings.Contains(err.Error(), "does not match runtime "+doctor.Version) {
		t.Fatalf("stale daemon must be rejected before room join, got %v", err)
	}
	select {
	case operation := <-operations:
		if operation != "daemon-info" {
			t.Fatalf("first operation must be daemon-info, got %s", operation)
		}
	default:
		t.Fatal("stale daemon did not receive the daemon-info probe")
	}
	select {
	case operation := <-operations:
		t.Fatalf("stale daemon received a room operation after rejection: %s", operation)
	default:
	}
}

func TestFormatCliErrorClassifier(t *testing.T) {
	auth := formatCliError(errString("authentication required by harness"))
	if !strings.Contains(auth, "Authenticate the selected Harness locally") {
		t.Fatalf("auth hint missing: %q", auth)
	}
	long := formatCliError(errString(strings.Repeat("y", 500)))
	if len(long) > 300 {
		t.Fatalf("300-char cap violated: %d", len(long))
	}
	scrubbed := formatCliError(errString("http 500: authorization: Bearer tok123 api_key: pk456"))
	if strings.Contains(scrubbed, "tok123") || strings.Contains(scrubbed, "pk456") {
		t.Fatalf("credentials leaked through formatting: %q", scrubbed)
	}
	if !strings.Contains(scrubbed, "[REDACTED]") {
		t.Fatalf("redaction marker missing: %q", scrubbed)
	}
	expired := formatCliError(errString(`{"error":"room_expired"}`))
	if !strings.Contains(expired, "has expired") {
		t.Fatalf("expiry hint missing: %q", expired)
	}
	spawnHint := formatCliError(errString("spawn opencode-acp failed"))
	if !strings.Contains(spawnHint, "Harness launcher is unavailable") {
		t.Fatalf("spawn hint missing: %q", spawnHint)
	}
	deadHarness := formatCliError(errString("ACP process exited (exit status 1)"))
	if !strings.Contains(deadHarness, "The Harness ACP process stopped before joining") {
		t.Fatalf("dead-harness hint missing: %q", deadHarness)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
