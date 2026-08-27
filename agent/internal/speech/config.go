package speech

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// LoadConfig resolves both slots from the runtime directory + environment.
// A missing or malformed storage file is a soft failure: speech simply
// reports not-ready and ordinary text behavior continues.
func LoadConfig(runtimeDir string, environ func(string) string) Config {
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
