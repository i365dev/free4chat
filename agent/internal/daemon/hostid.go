package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// hostSeedFile holds the PRIVATE random seed of THIS Runtime root (#176
// Phase A). The seed never leaves the machine; the public runtimeHostId is
// derived from it per Room via types.DeriveRuntimeHostID.
const hostSeedFile = "host-seed"

// RuntimeHostSeed returns the private random seed of one local Free4Chat
// Runtime installation/root (#176 Phase A).
//
// The seed is a random UUID created once and persisted under the Runtime
// directory (0600), so it is stable across daemon restarts and release
// upgrades of the same root, shared by every resident of that root, and
// distinct per root. It is NEVER derived from hostname, username, IP, MAC,
// or any other machine-identifying metadata, and it is never exposed to the
// Room — Room-visible runtimeHostId values are derived from it.
//
// Initialization is atomic and no-clobber (#178 review fix 1): the seed is
// written completely to a unique temp file and published into place with
// link(2), so no reader can ever observe an empty or partially written seed
// file, and a concurrent creator can never overwrite the winner's seed (the
// loser reads it). A malformed leftover file is regenerated (a lost grouping
// key is preferable to a poisoned one).
func RuntimeHostSeed() (string, error) {
	dir := RuntimeDirectory()
	path := filepath.Join(dir, hostSeedFile)
	if seed, err := readHostSeed(path); err == nil {
		return seed, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("runtime host seed directory failed: %w", err)
	}
	seed, err := newHostSeed()
	if err != nil {
		return "", fmt.Errorf("runtime host seed generation failed: %w", err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := publishSeedFile(path, seed); err == nil {
			return seed, nil
		} else if !os.IsExist(err) {
			return "", fmt.Errorf("runtime host seed publish failed: %w", err)
		}
		// Another creator won the race: read their (complete) seed.
		if existing, readErr := readHostSeed(path); readErr == nil {
			return existing, nil
		}
		// The existing file is malformed: remove and retry creation once.
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			return "", fmt.Errorf("runtime host seed replace failed: %w", removeErr)
		}
	}
	return "", fmt.Errorf("runtime host seed could not be settled")
}

// publishSeedFile atomically publishes a COMPLETE seed file without any
// clobbering window: write the full content to a unique temp file in the
// same directory, then link(2) it into place. link(2) fails with EEXIST
// when the destination already exists, so a concurrent creator is never
// overwritten and no reader can ever see an empty file.
func publishSeedFile(path, seed string) error {
	tmp := path + ".tmp-" + randomHex(8)
	if err := os.WriteFile(tmp, []byte(seed+"\n"), 0o600); err != nil {
		return err
	}
	linkErr := os.Link(tmp, path)
	removeErr := os.Remove(tmp)
	if linkErr != nil {
		return linkErr
	}
	if removeErr != nil && !os.IsNotExist(removeErr) {
		return removeErr
	}
	return nil
}

// readHostSeed validates and returns a previously persisted seed.
func readHostSeed(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	seed := strings.TrimSpace(string(raw))
	if !types.ValidRuntimeHostID(seed) {
		return "", fmt.Errorf("runtime host seed file is malformed")
	}
	return seed, nil
}

// newHostSeed generates a fresh opaque random seed (RFC 4122 v4 UUID).
func newHostSeed() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(b)
}
