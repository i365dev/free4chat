package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failReader errors on any read: it proves fail-closed paths never consume
// credential-shaped input.
type failReader struct{ read bool }

func (r *failReader) Read(p []byte) (int, error) {
	r.read = true
	return 0, errors.New("must not read")
}

// setupEnv builds a fresh stdout/stderr buffer pair for one setup call.
func setupBuffers() (*bytes.Buffer, *bytes.Buffer) {
	return &bytes.Buffer{}, &bytes.Buffer{}
}

func TestParseSpeechSetupArgs(t *testing.T) {
	provider, err := parseSpeechSetupArgs([]string{"--provider", "doubao"})
	if err != nil || provider != "doubao" {
		t.Fatalf("expected doubao, got %q err=%v", provider, err)
	}
	for _, args := range [][]string{
		{},
		{"--provider"},
		{"setup"},
		{"--api-key", "sekrit"},
		{"--api-key=sekrit"},
		{"--provider", "doubao", "--api-key", "sekrit"},
		{"--provider", "openai"},
		{"--provider", "doubao", "extra"},
	} {
		if _, err := parseSpeechSetupArgs(args); err == nil {
			t.Fatalf("expected failure for args %v", args)
		}
	}
}

func TestSpeechSetupRejectsNonInteractiveWithoutReading(t *testing.T) {
	stdout, stderr := setupBuffers()
	stdin := &failReader{}
	err := speechSetup("doubao", stdin, false, t.TempDir(), stdout, stderr)
	if err == nil || !strings.Contains(err.Error(), "interactive") {
		t.Fatalf("expected interactive-terminal error, got %v", err)
	}
	if stdin.read {
		t.Fatal("input was read despite non-interactive failure")
	}
	if strings.Contains(stdout.String()+stderr.String(), "sekrit") {
		t.Fatal("unexpected output")
	}
}

func TestSpeechSetupEmptyKeyFailsWithoutWrite(t *testing.T) {
	dir := t.TempDir()
	stdout, stderr := setupBuffers()
	err := speechSetup("doubao", strings.NewReader("\n"), true, dir, stdout, stderr)
	if err == nil || !strings.Contains(err.Error(), "no key entered") {
		t.Fatalf("expected empty-key error, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "credentials.json")); !os.IsNotExist(statErr) {
		t.Fatal("credentials.json was written despite empty key")
	}
}

func TestSpeechSetupPersistsKeyPreservesFieldsAndPermissions(t *testing.T) {
	dir := t.TempDir()
	credentialsPath := filepath.Join(dir, "credentials.json")
	original := `{
  "providers": {
    "doubao": {"voice": "zh_custom_voice"},
    "other": {"keep": "yes"}
  },
  "unrelated": {"nested": [1, 2, 3]},
  "note": "do not lose me"
}`
	if err := os.WriteFile(credentialsPath, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout, stderr := setupBuffers()
	const secret = "test-doubao-secret-key"
	if err := speechSetup("doubao", strings.NewReader(secret+"\n"), true, dir, stdout, stderr); err != nil {
		t.Fatalf("speechSetup failed: %v", err)
	}

	data, err := os.ReadFile(credentialsPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("credentials.json is not valid JSON: %v", err)
	}
	var providers map[string]json.RawMessage
	if err := json.Unmarshal(doc["providers"], &providers); err != nil {
		t.Fatal(err)
	}
	var doubao map[string]json.RawMessage
	if err := json.Unmarshal(providers["doubao"], &doubao); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := json.Unmarshal(doubao["apiKey"], &stored); err != nil || stored != secret {
		t.Fatalf("apiKey not persisted correctly: %q err=%v", stored, err)
	}
	var voice string
	if err := json.Unmarshal(doubao["voice"], &voice); err != nil || voice != "zh_custom_voice" {
		t.Fatalf("unrelated doubao field not preserved: %q err=%v", voice, err)
	}
	var other map[string]json.RawMessage
	if err := json.Unmarshal(providers["other"], &other); err != nil || len(other) == 0 {
		t.Fatal("unrelated provider section not preserved")
	}
	if _, ok := doc["unrelated"]; !ok {
		t.Fatal("unrelated top-level field not preserved")
	}
	if _, ok := doc["note"]; !ok {
		t.Fatal("top-level string field not preserved")
	}

	info, err := os.Stat(credentialsPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("credentials.json mode = %o, want 0600", perm)
	}
	// No temporary files left behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestSpeechSetupNeverPrintsTheSecret(t *testing.T) {
	dir := t.TempDir()
	stdout, stderr := setupBuffers()
	const secret = "super-secret-api-key-123"
	if err := speechSetup("doubao", strings.NewReader(secret+"\n"), true, dir, stdout, stderr); err != nil {
		t.Fatalf("speechSetup failed: %v", err)
	}
	combined := stdout.String() + stderr.String()
	if strings.Contains(combined, secret) {
		t.Fatal("the secret appeared in speech setup output")
	}
	// The prompt is visible; the key is not.
	if !strings.Contains(combined, "input hidden") {
		t.Fatal("expected the hidden-input prompt in output")
	}
	// The credential is persisted (sanity: the key exists only on disk).
	data, err := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if err != nil || !strings.Contains(string(data), secret) {
		t.Fatal("persisted credentials.json does not contain the key")
	}
}

func TestSpeechSetupMalformedCredentialsFailsClosed(t *testing.T) {
	dir := t.TempDir()
	credentialsPath := filepath.Join(dir, "credentials.json")
	garbage := []byte("not valid json {{{")
	if err := os.WriteFile(credentialsPath, garbage, 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr := setupBuffers()
	err := speechSetup("doubao", strings.NewReader("sekrit\n"), true, dir, stdout, stderr)
	if err == nil || !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("expected malformed-file error, got %v", err)
	}
	after, readErr := os.ReadFile(credentialsPath)
	if readErr != nil || !bytes.Equal(after, garbage) {
		t.Fatal("malformed credentials.json was modified")
	}
}

func TestSpeechSetupUnwritableDirectoryFailsClosed(t *testing.T) {
	parent := t.TempDir()
	blocker := filepath.Join(parent, "blocker")
	if err := os.WriteFile(blocker, []byte("file"), 0o644); err != nil {
		t.Fatal(err)
	}
	runtimeDir := filepath.Join(blocker, "sub")
	stdout, stderr := setupBuffers()
	err := speechSetup("doubao", strings.NewReader("sekrit\n"), true, runtimeDir, stdout, stderr)
	if err == nil {
		t.Fatal("expected failure for unwritable runtime directory")
	}
	if strings.Contains(stdout.String()+stderr.String(), "sekrit") {
		t.Fatal("the secret appeared in output on the failure path")
	}
}

func TestSpeechSetupSubprocessFailsClosedWithoutTTY(t *testing.T) {
	out, code := runCli(t, "speech", "setup", "--provider", "doubao")
	if code == 0 {
		t.Fatalf("expected non-interactive subprocess failure, got exit 0: %s", out)
	}
	if !strings.Contains(out, "interactive") {
		t.Fatalf("expected interactive-terminal guidance, got: %s", out)
	}
}

func TestSpeechSetupSubprocessRejectsSecretFlag(t *testing.T) {
	out, code := runCli(t, "speech", "setup", "--provider", "doubao", "--api-key", "sekrit")
	if code != 2 {
		t.Fatalf("expected usage exit 2 for --api-key, got %d: %s", code, out)
	}
	if strings.Contains(out, "sekrit") {
		t.Fatal("the rejected secret flag value appeared in output")
	}
}

func TestSpeechSetupSubprocessRejectsUnsupportedProvider(t *testing.T) {
	if _, code := runCli(t, "speech", "setup", "--provider", "openai"); code == 0 {
		t.Fatal("expected failure for unsupported provider")
	}
}

// TestSpeechSetupEchoDisableFailureFailsClosed proves the fail-closed echo
// contract: with an interactive TTY, if disabling echo fails, the input
// reader is never consumed and no credentials file is written.
func TestSpeechSetupEchoDisableFailureFailsClosed(t *testing.T) {
	old := disableTerminalEcho
	defer func() { disableTerminalEcho = old }()
	disableTerminalEcho = func(file *os.File) (func() error, error) {
		return nil, errors.New("simulated termios failure")
	}

	dir := t.TempDir()
	inputPath := filepath.Join(dir, "input.txt")
	const secret = "sekrit-that-must-not-be-read"
	if err := os.WriteFile(inputPath, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdin, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()

	stdout, stderr := setupBuffers()
	setupErr := speechSetup("doubao", stdin, true, dir, stdout, stderr)
	if setupErr == nil || !strings.Contains(setupErr.Error(), "echo") {
		t.Fatalf("expected echo-disable error, got %v", setupErr)
	}
	offset, err := stdin.Seek(0, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if offset != 0 {
		t.Fatal("input reader was consumed despite echo-disable failure")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "credentials.json")); !os.IsNotExist(statErr) {
		t.Fatal("credentials.json was written despite echo-disable failure")
	}
	if strings.Contains(stdout.String()+stderr.String(), secret) {
		t.Fatal("the secret appeared in output on the echo-disable failure path")
	}
}

// TestSpeechSetupEchoRestoreFailureFailsClosed: a failed echo restore is
// reported as a generic error and the credential is not persisted.
func TestSpeechSetupEchoRestoreFailureFailsClosed(t *testing.T) {
	old := disableTerminalEcho
	defer func() { disableTerminalEcho = old }()
	disableTerminalEcho = func(file *os.File) (func() error, error) {
		return func() error { return errors.New("simulated restore failure") }, nil
	}

	dir := t.TempDir()
	inputPath := filepath.Join(dir, "input.txt")
	const secret = "sekrit-with-restore-failure"
	if err := os.WriteFile(inputPath, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdin, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()

	stdout, stderr := setupBuffers()
	setupErr := speechSetup("doubao", stdin, true, dir, stdout, stderr)
	if setupErr == nil || !strings.Contains(setupErr.Error(), "restore") {
		t.Fatalf("expected restore error, got %v", setupErr)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "credentials.json")); !os.IsNotExist(statErr) {
		t.Fatal("credentials.json was written despite echo restore failure")
	}
	if strings.Contains(stdout.String()+stderr.String(), secret) {
		t.Fatal("the secret appeared in output on the restore failure path")
	}
}

// TestSpeechSetupSuccessOutputStatesRejoinRequirement pins the activation
// semantics in the success text: resident runtimes read speech config at
// join time, so an already-resident Agent must rejoin before the credential
// takes effect.
func TestSpeechSetupSuccessOutputStatesRejoinRequirement(t *testing.T) {
	dir := t.TempDir()
	stdout, stderr := setupBuffers()
	if err := speechSetup("doubao", strings.NewReader("test-key\n"), true, dir, stdout, stderr); err != nil {
		t.Fatalf("speechSetup failed: %v", err)
	}
	out := stdout.String()
	for _, want := range []string{"rejoin", "readiness"} {
		if !strings.Contains(out, want) {
			t.Fatalf("success output missing %q: %s", want, out)
		}
	}
}
