// Package credentials keeps optional provider credentials out of Room, ACP,
// and runtime configuration files. Implementations never return credential
// values in diagnostics or error strings.
package credentials

import (
	"errors"
	"os"
)

const serviceName = "com.free4chat.agent"

var (
	// ErrUnavailable means this host has no supported native secret store.
	// Callers must retain their explicit environment-variable path rather than
	// falling back to a plaintext file.
	ErrUnavailable = errors.New("native credential store is unavailable")
	ErrNotFound    = errors.New("credential is not configured")
)

// Store is the deliberately small boundary used by optional providers.
// provider/key identify a value but no method emits the value to a log or
// status projection.
type Store interface {
	Get(provider, key string) (string, error)
	Set(provider, key, value string) error
	Delete(provider, key string) error
}

// DefaultStore returns the platform-native store. Test subprocesses set the
// explicit opt-out below so unit tests never trigger an OS Keychain prompt.
// On hosts without a native store it reports ErrUnavailable; environment
// variables and legacy read-only import remain available through config.
func DefaultStore() Store {
	if os.Getenv("FREE4CHAT_TEST_DISABLE_NATIVE_CREDENTIAL_STORE") == "1" {
		return disabledStore{}
	}
	return newSystemStore()
}

type disabledStore struct{}

func (disabledStore) Get(string, string) (string, error) { return "", ErrUnavailable }
func (disabledStore) Set(string, string, string) error   { return ErrUnavailable }
func (disabledStore) Delete(string, string) error        { return ErrUnavailable }

// MemoryStore is intentionally exported for deterministic callers/tests; it
// is never selected by production wiring.
type MemoryStore struct{ Values map[string]string }

func (m *MemoryStore) Get(provider, key string) (string, error) {
	value, ok := m.Values[provider+"/"+key]
	if !ok {
		return "", ErrNotFound
	}
	return value, nil
}

func (m *MemoryStore) Set(provider, key, value string) error {
	if m.Values == nil {
		m.Values = map[string]string{}
	}
	m.Values[provider+"/"+key] = value
	return nil
}

func (m *MemoryStore) Delete(provider, key string) error {
	delete(m.Values, provider+"/"+key)
	return nil
}
