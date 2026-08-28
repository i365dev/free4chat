package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/credentials"
	"github.com/i365dev/free4chat/agent/internal/daemon"
	"github.com/i365dev/free4chat/agent/internal/speech"
)

const doubaoAPIKey = "apiKey"

var defaultCredentialStore = credentials.DefaultStore

// runSpeechSetup keeps the former terminal-only command as a compatibility
// alias. It now writes to the native credential store, never credentials.json.
func runSpeechSetup(args []string) error {
	provider, err := parseSpeechSetupArgs(args)
	if err != nil {
		return err
	}
	return speechSetup(provider, os.Stdin, stdinIsTerminal(), daemon.RuntimeDirectory(), os.Stdout, os.Stderr)
}

// runCredentialProvision is the Agent-triggerable path. On macOS it opens a
// native hidden-input dialog; the Harness only receives this command's bounded
// result and never the key itself.
func runCredentialProvision(args []string) error {
	provider, purpose, err := parseCredentialProvisionArgs(args)
	if err != nil {
		return err
	}
	key, err := credentials.PromptForSecret(provider, purpose)
	if err != nil {
		if errors.Is(err, credentials.ErrCancelled) {
			return errors.New("credential provisioning was cancelled; text collaboration is still available")
		}
		if errors.Is(err, credentials.ErrUnavailable) {
			return errors.New("native credential prompt is unavailable on this host; use DOUBAO_API_KEY for headless automation or run speech setup in a local terminal")
		}
		return errors.New("credential provisioning failed")
	}
	if err := provisionCredential(provider, key, defaultCredentialStore()); err != nil {
		return err
	}
	refreshResidentSpeech()
	fmt.Printf("credential configured: %s\n", provider)
	return nil
}

// runCredentialStatus intentionally reports capability state only. It never
// reveals a credential value, fingerprint, source path, or Keychain account.
func runCredentialStatus() error {
	config := speech.LoadConfig(daemon.RuntimeDirectory(), os.Getenv)
	return printJSON(map[string]any{
		"provider":   "doubao",
		"configured": config.STTEnabled || config.TTSEnabled,
		"ready":      config.STTEnabled || config.TTSEnabled,
	})
}

func parseSpeechSetupArgs(args []string) (string, error) {
	provider, purpose, err := parseCredentialProvisionArgs(args)
	if err != nil || purpose != "" {
		return "", errUsage()
	}
	return provider, nil
}

func parseCredentialProvisionArgs(args []string) (provider, purpose string, err error) {
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--provider":
			if i+1 >= len(args) || provider != "" {
				return "", "", errUsage()
			}
			provider = args[i+1]
			i++
		case "--purpose":
			if i+1 >= len(args) || purpose != "" {
				return "", "", errUsage()
			}
			purpose = args[i+1]
			i++
		default:
			return "", "", errUsage()
		}
	}
	if provider != "doubao" {
		return "", "", errors.New("credential provisioning supports only --provider doubao")
	}
	if purpose != "" && purpose != "speech.stt" && purpose != "speech.tts" {
		return "", "", errors.New("credential purpose must be speech.stt or speech.tts")
	}
	return provider, purpose, nil
}

func stdinIsTerminal() bool { return isTerminal(os.Stdin) }

var disableTerminalEcho = termDisableEcho

// speechSetup is the backwards-compatible terminal entrypoint. runtimeDir is
// retained for source compatibility with callers/tests but credentials live in
// the OS store and are shared across Rooms, not in that directory.
func speechSetup(provider string, stdin io.Reader, interactive bool, runtimeDir string, stdout, stderr io.Writer) error {
	if !interactive {
		return errors.New("speech setup requires an interactive local terminal; the credential is never accepted from non-interactive input, scripts, room content, or Agent prompts")
	}
	fmt.Fprint(stderr, "Enter Doubao API key (input hidden): ")
	key, err := readSecret(stdin, stderr)
	if err != nil {
		return err
	}
	if err := provisionCredential(provider, key, defaultCredentialStore()); err != nil {
		return err
	}
	refreshResidentSpeech()
	fmt.Fprintln(stdout, "Speech configured (provider doubao).")
	fmt.Fprintln(stdout, "The credential is in this device's native secret store. Resident Rooms reload it without leaving or rejoining.")
	fmt.Fprintln(stdout, "Then run `free4chat-agent readiness --json` to confirm.")
	return nil
}

func provisionCredential(provider, key string, store credentials.Store) error {
	if err := validateAPIKey(key); err != nil {
		return err
	}
	if store == nil {
		return errors.New("native credential store is unavailable; no credential was saved")
	}
	if err := store.Set(provider, doubaoAPIKey, key); err != nil {
		return errors.New("native credential store is unavailable; no credential was saved")
	}
	return nil
}

// refreshResidentSpeech best-effort refreshes a daemon that is already
// running. It never starts a daemon or affects an otherwise healthy text Room.
func refreshResidentSpeech() {
	_, _ = daemon.SendIPC(&daemon.IpcRequest{Op: "reload-speech"})
}

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
