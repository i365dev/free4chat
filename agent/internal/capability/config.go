package capability

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

const registrationFileName = "capability-adapter.json"

// SaveRegistration persists only the approved executable and its arguments.
// Adapter integration config and secrets are owned by the Adapter itself.
func SaveRegistration(runtimeDir string, registration Registration) error {
	if !registration.Valid() {
		return ErrInvalidRegistration
	}
	data, err := json.Marshal(registration)
	if err != nil || len(data) > MaxAdapterConfig {
		return ErrInvalidRegistration
	}
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return errors.New("local Adapter registration failed")
	}
	path := filepath.Join(runtimeDir, registrationFileName)
	tmp, err := os.CreateTemp(runtimeDir, ".capability-adapter-*")
	if err != nil {
		return errors.New("local Adapter registration failed")
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return errors.New("local Adapter registration failed")
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return errors.New("local Adapter registration failed")
	}
	if err := tmp.Close(); err != nil {
		return errors.New("local Adapter registration failed")
	}
	if err := os.Rename(tmpName, path); err != nil {
		return errors.New("local Adapter registration failed")
	}
	return nil
}

// LoadRegistration returns nil for an unregistered Adapter and fails closed
// for malformed or oversized local registration data.
func LoadRegistration(runtimeDir string) (*Registration, error) {
	data, err := os.ReadFile(filepath.Join(runtimeDir, registrationFileName))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil || len(data) > MaxAdapterConfig {
		return nil, ErrInvalidRegistration
	}
	var registration Registration
	if json.Unmarshal(data, &registration) != nil || !registration.Valid() {
		return nil, ErrInvalidRegistration
	}
	return &registration, nil
}

func RemoveRegistration(runtimeDir string) error {
	err := os.Remove(filepath.Join(runtimeDir, registrationFileName))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("local Adapter removal failed")
	}
	return nil
}
