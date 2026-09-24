package speech

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/credentials"
)

func TestLoadConfigPrefersEnvironmentThenNativeStoreThenLegacyFile(t *testing.T) {
	dir := t.TempDir()
	legacy := `{"providers":{"doubao":{"apiKey":"legacy-secret","voice":"legacy-voice"}}}`
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &credentials.MemoryStore{Values: map[string]string{"doubao/apiKey": "keychain-secret"}}

	fromStore := LoadConfigWithStore(dir, func(string) string { return "" }, store)
	if fromStore.APIKey != "keychain-secret" || !fromStore.STTEnabled || !fromStore.TTSEnabled {
		t.Fatalf("native store was not selected: %+v", fromStore)
	}
	if fromStore.Voice != "legacy-voice" {
		t.Fatalf("legacy non-secret config should remain compatible: %+v", fromStore)
	}

	fromEnv := LoadConfigWithStore(dir, func(key string) string {
		if key == "DOUBAO_API_KEY" {
			return "environment-secret"
		}
		return ""
	}, store)
	if fromEnv.APIKey != "environment-secret" {
		t.Fatalf("environment must override native storage: %+v", fromEnv)
	}
}

func TestLoadConfigKeepsSpeechOffAndSkipsNativeStoreByDefault(t *testing.T) {
	store := &countingStore{value: "stored-key"}
	config := LoadConfigWithStore(t.TempDir(), func(string) string { return "" }, store)
	if config.APIKey != "" || config.STTEnabled || config.TTSEnabled {
		t.Fatalf("speech must remain disabled without explicit opt-in: %+v", config)
	}
	if store.getCalls != 0 {
		t.Fatalf("ordinary Runtime setup read the native credential store %d times", store.getCalls)
	}
}

func TestLoadConfigReadsNativeStoreOnlyForSelectedSpeechSlot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"other":"kept","speech":{"stt":{"provider":"doubao"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &countingStore{value: "stored-key"}
	config := LoadConfigWithStore(dir, func(string) string { return "" }, store)
	if config.APIKey != "stored-key" || !config.STTEnabled || config.TTSEnabled {
		t.Fatalf("explicit STT selection was not applied: %+v", config)
	}
	if store.getCalls != 1 {
		t.Fatalf("explicit speech opt-in should read native storage once, got %d", store.getCalls)
	}
}

func TestEnableProvidersPreservesOtherRuntimeConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"existing":{"value":1},"speech":{"tts":{"provider":"none","voice":"voice"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnableProviders(dir, true, false); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["existing"].(map[string]any)["value"] != float64(1) {
		t.Fatalf("unrelated Runtime config was lost: %s", data)
	}
	speechDoc := got["speech"].(map[string]any)
	if speechDoc["stt"].(map[string]any)["provider"] != "doubao" {
		t.Fatalf("selected STT provider was not stored: %s", data)
	}
	if tts := speechDoc["tts"].(map[string]any); tts["provider"] != "none" || tts["voice"] != "voice" {
		t.Fatalf("unselected TTS config changed: %s", data)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Runtime config permissions changed: info=%v err=%v", info, err)
	}
}

func TestLoadConfigTreatsUnavailableStoreAsSoftFailure(t *testing.T) {
	config := LoadConfigWithStore(t.TempDir(), func(string) string { return "" }, unavailableTestStore{})
	if config.STTEnabled || config.TTSEnabled || config.APIKey != "" {
		t.Fatalf("unavailable storage must leave optional speech disabled: %+v", config)
	}
}

func TestDeleteLegacyAPIKeyPreservesOtherCredentialFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	contents := `{
  "providers": {
    "doubao": {"apiKey":"legacy-secret","voice":"voice-kept"},
    "other": {"token":"keep"}
  },
  "otherConfig": {"enabled": true}
}`
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := DeleteLegacyAPIKey(dir); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	providers := document["providers"].(map[string]any)
	doubao := providers["doubao"].(map[string]any)
	if _, ok := doubao["apiKey"]; ok {
		t.Fatal("legacy apiKey still present after explicit delete")
	}
	if doubao["voice"] != "voice-kept" || providers["other"].(map[string]any)["token"] != "keep" ||
		document["otherConfig"].(map[string]any)["enabled"] != true {
		t.Fatalf("unrelated legacy configuration changed: %#v", document)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("legacy file permissions changed: info=%v err=%v", info, err)
	}
}

type unavailableTestStore struct{}

type countingStore struct {
	value    string
	getCalls int
}

func (s *countingStore) Get(string, string) (string, error) {
	s.getCalls++
	if s.value == "" {
		return "", credentials.ErrNotFound
	}
	return s.value, nil
}
func (*countingStore) Set(string, string, string) error { return nil }
func (*countingStore) Delete(string, string) error      { return nil }

func (unavailableTestStore) Get(string, string) (string, error) {
	return "", credentials.ErrUnavailable
}
func (unavailableTestStore) Set(string, string, string) error { return credentials.ErrUnavailable }
func (unavailableTestStore) Delete(string, string) error      { return credentials.ErrUnavailable }
