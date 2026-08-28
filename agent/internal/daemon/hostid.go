package daemon

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// hostIDFile holds the stable opaque identity of THIS Runtime root.
const hostIDFile = "host-id"

// RuntimeHostID returns the stable opaque identity of one local Free4Chat
// Runtime installation/root (#176 Phase A).
//
// The id is a random UUID created once and persisted under the Runtime
// directory, so it is:
//   - stable across daemon restarts and release upgrades of the same root;
//   - shared by every resident Agent of that root;
//   - distinct for distinct Runtime roots;
//   - NEVER derived from hostname, username, IP, MAC address, or any other
//     machine-identifying metadata — it is safe to expose only as an opaque
//     grouping key inside Room state.
//
// A malformed leftover file is replaced (a lost grouping key is preferable
// to a poisoned one). Concurrent first-use is safe: creation uses O_EXCL
// and the loser reads the winner's file.
func RuntimeHostID() (string, error) {
	dir := RuntimeDirectory()
	path := filepath.Join(dir, hostIDFile)
	if id, err := readHostID(path); err == nil {
		return id, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("runtime host id directory failed: %w", err)
	}
	id, err := newHostID()
	if err != nil {
		return "", fmt.Errorf("runtime host id generation failed: %w", err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			if _, writeErr := file.WriteString(id + "\n"); writeErr != nil {
				_ = file.Close()
				return "", fmt.Errorf("runtime host id write failed: %w", writeErr)
			}
			if closeErr := file.Close(); closeErr != nil {
				return "", fmt.Errorf("runtime host id write failed: %w", closeErr)
			}
			return id, nil
		}
		if !os.IsExist(err) {
			return "", fmt.Errorf("runtime host id create failed: %w", err)
		}
		if existing, readErr := readHostID(path); readErr == nil {
			return existing, nil
		}
		// The existing file is malformed: remove and retry creation once.
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			return "", fmt.Errorf("runtime host id replace failed: %w", removeErr)
		}
	}
	return "", fmt.Errorf("runtime host id could not be settled")
}

// readHostID validates and returns a previously persisted host id.
func readHostID(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(raw))
	if !validRuntimeHostID(id) {
		return "", fmt.Errorf("runtime host id file is malformed")
	}
	return id, nil
}

// newHostID generates a fresh opaque random id (RFC 4122 v4 UUID).
func newHostID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// validRuntimeHostID is the single validation rule shared with the Room
// side (#176): opaque charset, bounded length. No semantics are attached.
func validRuntimeHostID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.', r == ':':
		default:
			return false
		}
	}
	return true
}
