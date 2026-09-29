package capability

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const configFileName = "local-capability.json"

type localConfig struct {
	FixtureEndpoint string `json:"fixtureEndpoint"`
}

// SaveFixtureEndpoint stores the operator-selected loopback fixture origin in
// a private Runtime-local config file. It deliberately has no registry shape.
func SaveFixtureEndpoint(runtimeDir, endpoint string) error {
	if _, err := validateFixtureEndpoint(endpoint); err != nil {
		return ErrUnavailable
	}
	data, err := json.Marshal(localConfig{FixtureEndpoint: endpoint})
	if err != nil {
		return errors.New("local capability configuration failed")
	}
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return errors.New("local capability configuration failed")
	}
	path := filepath.Join(runtimeDir, configFileName)
	tmp, err := os.CreateTemp(runtimeDir, ".local-capability-*")
	if err != nil {
		return errors.New("local capability configuration failed")
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return errors.New("local capability configuration failed")
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return errors.New("local capability configuration failed")
	}
	if err := tmp.Close(); err != nil {
		return errors.New("local capability configuration failed")
	}
	if err := os.Rename(tmpName, path); err != nil {
		return errors.New("local capability configuration failed")
	}
	return nil
}

// LoadFixtureAdapter creates the configured adapter without returning its
// endpoint or any underlying parser/network error to callers.
func LoadFixtureAdapter(runtimeDir string) (*FixtureAdapter, error) {
	data, err := os.ReadFile(filepath.Join(runtimeDir, configFileName))
	if err != nil || len(data) > 512 {
		return nil, ErrUnavailable
	}
	var config localConfig
	if json.Unmarshal(data, &config) != nil {
		return nil, ErrUnavailable
	}
	return NewFixtureAdapter(config.FixtureEndpoint)
}
