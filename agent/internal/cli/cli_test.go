package cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var binaryPath string

// TestMain builds the real free4chat-agent binary once: the routing
// regression guard (#105 review) pins dispatcher behavior via subprocess
// exits, which requires the actual executable.
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
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func runCli(t *testing.T, args ...string) (string, int) {
	t.Helper()
	dir, err := os.MkdirTemp("", "fcagent-")
	if err != nil {
		t.Fatalf("temp dir failed: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
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
