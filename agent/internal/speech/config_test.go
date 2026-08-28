package speech

import (
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

type unavailableTestStore struct{}

func (unavailableTestStore) Get(string, string) (string, error) {
	return "", credentials.ErrUnavailable
}
func (unavailableTestStore) Set(string, string, string) error { return credentials.ErrUnavailable }
func (unavailableTestStore) Delete(string, string) error      { return credentials.ErrUnavailable }
