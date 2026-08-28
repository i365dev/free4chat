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

	// Doubao is the only production provider in PR2; an explicit different
	// selection fails closed (both slots disabled).
	selectsDoubao := func(id string) bool {
		return id == "" || id == "doubao"
	}
	sttOK := selectsDoubao(sttProvider)
	ttsOK := selectsDoubao(ttsProvider)

	stored := credentials.Providers["doubao"]
	apiKey := ""
	voice := ""
	if stored != nil {
		apiKey = stored["apiKey"]
		voice = stored["voice"]
	}
	if store != nil {
		if fromStore, err := store.Get("doubao", "apiKey"); err == nil && strings.TrimSpace(fromStore) != "" {
			apiKey = strings.TrimSpace(fromStore)
		}
	}
	if fromEnv := strings.TrimSpace(env("DOUBAO_API_KEY")); fromEnv != "" {
		apiKey = fromEnv
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
