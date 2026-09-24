package speech

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/credentials"
)

// Config resolves the Doubao-only speech configuration surface used by the
// frozen Node production path: local config.json/credentials.json under the
// runtime directory plus explicit environment overrides. Secrets exist only
// in the values handed to provider constructors — never logged or returned.
type Config struct {
	// STTEnabled/TTSEnabled report whether each slot is configured with the
	// required credential.
	STTEnabled bool
	TTSEnabled bool
	// APIKey is the shared Doubao console credential (DOUBAO_API_KEY or
	// credentials.json). Zero value disables both capabilities safely.
	APIKey string
	// Voice is the TTS 2.0 speaker id (DOUBAO_TTS_VOICE or credentials.json).
	Voice string
}

// LoadConfig resolves both slots from explicit environment values, then the
// native credential store, then legacy credentials.json. A missing or
// malformed source is a soft failure: speech simply reports not-ready and
// ordinary text behavior continues.
func LoadConfig(runtimeDir string, environ func(string) string) Config {
	return LoadConfigWithStore(runtimeDir, environ, credentials.DefaultStore())
}

// LoadConfigWithStore is the injectable form used by local credential
// provisioning and tests. New credentials are never written to the legacy
// file; it is read only so existing installations continue to work.
func LoadConfigWithStore(runtimeDir string, environ func(string) string, store credentials.Store) Config {
	env := environ
	config := Config{}

	sttProvider := strings.TrimSpace(env("FREE4CHAT_STT_PROVIDER"))
	ttsProvider := strings.TrimSpace(env("FREE4CHAT_TTS_PROVIDER"))

	type speechConfigFile struct {
		Speech struct {
			STT *struct {
				Provider string `json:"provider"`
			} `json:"stt"`
			TTS *struct {
				Provider string `json:"provider"`
			} `json:"tts"`
		} `json:"speech"`
	}
	type credentialsFile struct {
		Providers map[string]map[string]string `json:"providers"`
	}

	var fileConfig speechConfigFile
	var credentials credentialsFile

	if runtimeDir != "" {
		if data, err := os.ReadFile(filepath.Join(runtimeDir, "config.json")); err == nil {
			_ = json.Unmarshal(data, &fileConfig)
		}
		if data, err := os.ReadFile(filepath.Join(runtimeDir, "credentials.json")); err == nil {
			_ = json.Unmarshal(data, &credentials)
		}
	}

	if sttProvider == "" {
		if fileConfig.Speech.STT != nil {
			sttProvider = strings.TrimSpace(fileConfig.Speech.STT.Provider)
		}
	}
	if ttsProvider == "" {
		if fileConfig.Speech.TTS != nil {
			ttsProvider = strings.TrimSpace(fileConfig.Speech.TTS.Provider)
		}
	}

	// Speech is opt-in. In particular, an installed credential in the native
	// store must not make every ordinary Runtime join/readiness check prompt
	// macOS Keychain access. speech setup persists explicit provider selections;
	// environment credentials are also an explicit opt-in for automation.
	legacyAPIKey := ""

	stored := credentials.Providers["doubao"]
	legacyAPIKey = stored["apiKey"]
	voice := ""
	if stored != nil {
		voice = stored["voice"]
	}
	envAPIKey := strings.TrimSpace(env("DOUBAO_API_KEY"))
	if envAPIKey != "" || legacyAPIKey != "" {
		if sttProvider == "" {
			sttProvider = "doubao"
		}
		if ttsProvider == "" {
			ttsProvider = "doubao"
		}
	}
	sttOK := sttProvider == "doubao"
	ttsOK := ttsProvider == "doubao"

	apiKey := ""
	if envAPIKey == "" && store != nil && (sttOK || ttsOK) {
		if fromStore, err := store.Get("doubao", "apiKey"); err == nil && strings.TrimSpace(fromStore) != "" {
			apiKey = strings.TrimSpace(fromStore)
		}
	}
	if apiKey == "" {
		apiKey = legacyAPIKey
	}
	if envAPIKey != "" {
		apiKey = envAPIKey
	}
	if fromEnv := strings.TrimSpace(env("DOUBAO_TTS_VOICE")); fromEnv != "" {
		voice = fromEnv
	}

	config.APIKey = apiKey
	config.Voice = voice
	config.STTEnabled = sttOK && apiKey != ""
	config.TTSEnabled = ttsOK && apiKey != ""
	return config
}

// EnableProviders persists explicit speech opt-in without writing a
// credential. Existing unrelated Runtime config is preserved.
func EnableProviders(runtimeDir string, stt, tts bool) error {
	if runtimeDir == "" || (!stt && !tts) {
		return errors.New("speech provider selection is invalid")
	}
	path := filepath.Join(runtimeDir, "config.json")
	document := map[string]json.RawMessage{}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &document); err != nil {
			return errors.New("Runtime config is not valid JSON; speech settings were not changed")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("Runtime config could not be read; speech settings were not changed")
	}

	speechDocument := map[string]json.RawMessage{}
	if raw, ok := document["speech"]; ok {
		if err := json.Unmarshal(raw, &speechDocument); err != nil || speechDocument == nil {
			return errors.New("Runtime speech config is invalid; speech settings were not changed")
		}
	}
	enableSlot := func(name string) error {
		slot := map[string]json.RawMessage{}
		if raw, ok := speechDocument[name]; ok {
			if err := json.Unmarshal(raw, &slot); err != nil || slot == nil {
				return errors.New("Runtime speech slot config is invalid; speech settings were not changed")
			}
		}
		provider, _ := json.Marshal("doubao")
		slot["provider"] = provider
		encoded, err := json.Marshal(slot)
		if err != nil {
			return errors.New("Runtime speech settings could not be encoded")
		}
		speechDocument[name] = encoded
		return nil
	}
	if stt {
		if err := enableSlot("stt"); err != nil {
			return err
		}
	}
	if tts {
		if err := enableSlot("tts"); err != nil {
			return err
		}
	}
	encodedSpeech, err := json.Marshal(speechDocument)
	if err != nil {
		return errors.New("Runtime speech settings could not be encoded")
	}
	document["speech"] = encodedSpeech
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return errors.New("Runtime config could not be encoded")
	}
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return errors.New("Runtime config directory could not be created")
	}
	temporary, err := os.CreateTemp(runtimeDir, ".config-speech-*.tmp")
	if err != nil {
		return errors.New("Runtime config could not be written")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return errors.New("Runtime config permissions could not be set")
	}
	if _, err := temporary.Write(append(encoded, '\n')); err != nil {
		_ = temporary.Close()
		return errors.New("Runtime config could not be written")
	}
	if err := temporary.Close(); err != nil {
		return errors.New("Runtime config could not be closed")
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return errors.New("Runtime config could not be updated")
	}
	return nil
}

// ErrNotConfigured is returned by provider factories when the credential is
// missing; callers must treat it as "speech not ready", never a room failure.
var ErrNotConfigured = errors.New("doubao speech is not configured")

// DeleteLegacyAPIKey removes only the legacy providers.doubao.apiKey field.
// It is used by an explicit credential delete so a removed Keychain value
// cannot silently reactivate an upgraded installation's plaintext key. Other
// providers, Doubao voice configuration, and unrelated JSON fields survive.
func DeleteLegacyAPIKey(runtimeDir string) error {
	if runtimeDir == "" {
		return nil
	}
	path := filepath.Join(runtimeDir, "credentials.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("cannot read legacy credential file")
	}

	doc := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &doc); err != nil {
		return errors.New("legacy credential file is not valid JSON; no credential was deleted")
	}
	rawProviders, ok := doc["providers"]
	if !ok || string(rawProviders) == "null" {
		return nil
	}
	providers := map[string]json.RawMessage{}
	if err := json.Unmarshal(rawProviders, &providers); err != nil || providers == nil {
		return errors.New("legacy credential file has a malformed providers section; no credential was deleted")
	}
	rawDoubao, ok := providers["doubao"]
	if !ok || string(rawDoubao) == "null" {
		return nil
	}
	doubao := map[string]json.RawMessage{}
	if err := json.Unmarshal(rawDoubao, &doubao); err != nil || doubao == nil {
		return errors.New("legacy credential file has a malformed doubao section; no credential was deleted")
	}
	if _, ok := doubao["apiKey"]; !ok {
		return nil
	}
	delete(doubao, "apiKey")
	updatedDoubao, err := json.Marshal(doubao)
	if err != nil {
		return errors.New("legacy credential cleanup failed")
	}
	providers["doubao"] = updatedDoubao
	updatedProviders, err := json.Marshal(providers)
	if err != nil {
		return errors.New("legacy credential cleanup failed")
	}
	doc["providers"] = updatedProviders
	updated, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return errors.New("legacy credential cleanup failed")
	}
	updated = append(updated, '\n')

	info, err := os.Stat(path)
	if err != nil {
		return errors.New("legacy credential cleanup failed")
	}
	mode := info.Mode().Perm()
	if mode == 0 {
		mode = 0o600
	}
	tmp, err := os.CreateTemp(runtimeDir, ".credentials-*.tmp")
	if err != nil {
		return errors.New("legacy credential cleanup failed")
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if err := tmp.Chmod(mode); err != nil {
		cleanup()
		return errors.New("legacy credential cleanup failed")
	}
	if _, err := tmp.Write(updated); err != nil {
		cleanup()
		return errors.New("legacy credential cleanup failed")
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return errors.New("legacy credential cleanup failed")
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return errors.New("legacy credential cleanup failed")
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return errors.New("legacy credential cleanup failed")
	}
	return nil
}
