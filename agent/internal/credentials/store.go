// Package credentials keeps optional provider credentials out of Room, ACP,
// and runtime configuration files. Implementations never return credential
// values in diagnostics or error strings.
package credentials

import "errors"

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

// DefaultStore returns the platform-native store. On hosts without one it
// reports ErrUnavailable; environment variables and legacy read-only import
// remain available through the speech config resolver.
func DefaultStore() Store { return newSystemStore() }

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
