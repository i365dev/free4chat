package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/daemon"
)

// runSpeechSetup implements `free4chat-agent speech setup --provider doubao`.
// The credential is read interactively from a local terminal only (echo
// disabled) and persisted into the runtime directory's credentials.json.
// The key is never printed, logged, or accepted from flags, files, room
// content, MCP, ACP, or the Harness.
func runSpeechSetup(args []string) error {
	provider, err := parseSpeechSetupArgs(args)
	if err != nil {
		return err
	}
	return speechSetup(provider, os.Stdin, stdinIsTerminal(), daemon.RuntimeDirectory(), os.Stdout, os.Stderr)
}

// parseSpeechSetupArgs accepts exactly `--provider doubao` and nothing else.
// Any other token — including a `--api-key`-style secret flag — fails closed
// with a usage error.
func parseSpeechSetupArgs(args []string) (string, error) {
	provider := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--provider" {
			if i+1 >= len(args) {
				return "", errUsage()
			}
			provider = args[i+1]
			i++
			continue
		}
		return "", errUsage()
	}
	if provider == "" {
		return "", errUsage()
	}
	if provider != "doubao" {
		return "", fmt.Errorf("speech setup supports only --provider doubao")
	}
	return provider, nil
}

// stdinIsTerminal reports whether the process stdin is a real terminal
// (isatty semantics, not just a character device — /dev/null is rejected).
func stdinIsTerminal() bool {
	return isTerminal(os.Stdin)
}

// disableTerminalEcho is the injectable seam for deterministic failure-path
// tests; the production wiring is termDisableEcho (real termios ioctls).
var disableTerminalEcho = termDisableEcho

// speechSetup is the testable core: interactive-only, echo-disabled read of
// the provider credential, validated, then persisted into credentials.json
// with 0600 permissions while preserving every unrelated field.
func speechSetup(provider string, stdin io.Reader, interactive bool, runtimeDir string, stdout, stderr io.Writer) error {
	if !interactive {
		return errors.New("speech setup requires an interactive local terminal; the credential is never accepted from non-interactive input, scripts, room content, or Agent prompts")
	}

	fmt.Fprint(stderr, "Enter Doubao API key (input hidden): ")
	key, err := readSecret(stdin, stderr)
	if err != nil {
		return err
	}
	if err := validateAPIKey(key); err != nil {
		return err
	}
	if err := persistAPIKey(runtimeDir, key); err != nil {
		return err
	}
	fmt.Fprintln(stdout, "Speech configured (provider doubao).")
	fmt.Fprintln(stdout, "The resident runtime reads speech configuration when it joins a room: if an Agent is already resident, leave the room and rejoin (or stop the daemon and join again) before the new credential takes effect.")
	fmt.Fprintln(stdout, "Then run `free4chat-agent readiness --json` to confirm.")
	return nil
}

// readSecret reads one line with terminal echo disabled when stdin is a real
// terminal file. It fails closed: if echo cannot be confirmed disabled (or
// cannot be restored afterward), no credential is returned and only generic
// errors are reported — the key itself is never echoed to any stream.
func readSecret(stdin io.Reader, stderr io.Writer) (string, error) {
	restore := func() error { return nil }
	if file, ok := stdin.(*os.File); ok {
		var err error
		if restore, err = disableTerminalEcho(file); err != nil {
			fmt.Fprintln(stderr)
			return "", errors.New("could not disable terminal echo; no credential input was read")
		}
	}
	reader := bufio.NewReader(stdin)
	line, readErr := reader.ReadString('\n')
	// The terminal echo is off, so restore the user's line break visually.
	fmt.Fprintln(stderr)
	if restoreErr := restore(); restoreErr != nil {
		return "", errors.New("could not restore terminal echo; the credential was not saved")
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return "", readErr
	}
	line = strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(line) == "" {
		return "", errors.New("no key entered; speech setup did not change any configuration")
	}
	return strings.TrimSpace(line), nil
}

// validateAPIKey rejects empty, overlong, or whitespace/control-bearing keys
// without logging the value.
func validateAPIKey(key string) error {
	if len(key) > 512 {
		return errors.New("entered key is too long")
	}
	for _, r := range key {
		if r <= 32 || r == 127 {
			return errors.New("entered key contains invalid characters")
		}
	}
	return nil
}

// persistAPIKey writes providers.doubao.apiKey into credentials.json under
// runtimeDir, preserving every other existing field byte-for-byte (via
// json.RawMessage), using a 0600 temp file plus rename. Malformed existing
// files fail closed and are never overwritten.
func persistAPIKey(runtimeDir, key string) error {
	credentialsPath := filepath.Join(runtimeDir, "credentials.json")

	doc := map[string]json.RawMessage{}
	if data, err := os.ReadFile(credentialsPath); err == nil {
		if len(data) > 0 {
			if err := json.Unmarshal(data, &doc); err != nil {
				return errors.New("credentials.json exists but is not valid JSON; fix or remove it before running speech setup")
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot read credentials.json: %w", err)
	}

	providers := map[string]json.RawMessage{}
	if raw, ok := doc["providers"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &providers); err != nil || providers == nil {
			return errors.New("credentials.json has a malformed providers section; fix or remove it before running speech setup")
		}
	}
	doubao := map[string]json.RawMessage{}
	if raw, ok := providers["doubao"]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &doubao); err != nil || doubao == nil {
			return errors.New("credentials.json has a malformed doubao section; fix or remove it before running speech setup")
		}
	}
	keyJSON, err := json.Marshal(key)
	if err != nil {
		return err
	}
	doubao["apiKey"] = keyJSON
	providersJSON, err := json.Marshal(doubao)
	if err != nil {
		return err
	}
	providers["doubao"] = providersJSON
	docJSON, err := json.Marshal(providers)
	if err != nil {
		return err
	}
	doc["providers"] = docJSON

	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')

	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return fmt.Errorf("cannot create runtime directory: %w", err)
	}
	tmp, err := os.CreateTemp(runtimeDir, ".credentials-*.tmp")
	if err != nil {
		return fmt.Errorf("cannot write credentials.json: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(out); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, credentialsPath); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("cannot write credentials.json: %w", err)
	}
	return nil
}
