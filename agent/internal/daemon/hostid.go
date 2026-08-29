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
// The whole read-evaluate-publish sequence is SERIALIZED across processes
// and goroutines via an exclusive flock (#178 review fix 2). Without it,
// two callers that both observe a malformed file could each remove and
// republish DIFFERENT seeds (one caller's removal could even delete the
// other's freshly published valid seed). Initialization stays atomic and
// no-clobber: the complete seed is published with link(2) from a unique
// temp file, so no reader ever observes an empty file. A malformed leftover
// file is replaced under the lock (a lost grouping key is preferable to a
// poisoned one).
func RuntimeHostSeed() (string, error) {
	dir := RuntimeDirectory()
	path := filepath.Join(dir, hostSeedFile)
	if seed, err := readHostSeed(path); err == nil {
		return seed, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("runtime host seed directory failed: %w", err)
	}
	release, err := lockHostSeed(dir)
	if err != nil {
		return "", fmt.Errorf("runtime host seed lock failed: %w", err)
	}
	defer release()
	// Re-read under the lock: a competing caller may have published a valid
	// seed while this one waited for it.
	if seed, err := readHostSeed(path); err == nil {
		return seed, nil
	}
	seed, err := newHostSeed()
	if err != nil {
		return "", fmt.Errorf("runtime host seed generation failed: %w", err)
	}
	// Serialized replace (#178 review fix 2): remove any malformed leftover,
	// then atomically publish the complete new file (link(2) — still no
	// empty window). No other process or goroutine can interleave here.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("runtime host seed replace failed: %w", err)
	}
	if err := publishSeedFile(path, seed); err != nil {
		return "", fmt.Errorf("runtime host seed publish failed: %w", err)
	}
	return seed, nil
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
