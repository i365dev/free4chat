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

func (unavailableTestStore) Get(string, string) (string, error) {
	return "", credentials.ErrUnavailable
}
func (unavailableTestStore) Set(string, string, string) error { return credentials.ErrUnavailable }
func (unavailableTestStore) Delete(string, string) error      { return credentials.ErrUnavailable }
