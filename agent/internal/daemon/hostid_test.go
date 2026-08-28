package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #176 Phase A: the Runtime Host id is a stable opaque grouping key for one
// Runtime root. It must persist across calls, differ across roots, and never
// be derived from machine metadata.
func TestRuntimeHostIDStableWithinRoot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)

	first, err := RuntimeHostID()
	if err != nil {
		t.Fatalf("first RuntimeHostID failed: %v", err)
	}
	for i := 0; i < 3; i++ {
		again, err := RuntimeHostID()
		if err != nil {
			t.Fatalf("repeat RuntimeHostID failed: %v", again)
		}
		if again != first {
			t.Fatalf("host id must be stable within one root: %s vs %s", first, again)
		}
	}

	// Persisted file: 0600, opaque bounded charset only.
	data, err := os.ReadFile(filepath.Join(dir, hostIDFile))
	if err != nil {
		t.Fatalf("host id file missing: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, hostIDFile))
	if err != nil {
		t.Fatalf("host id stat failed: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("host id file must be 0600, got %v", perm)
	}
	if !validRuntimeHostID(strings.TrimSpace(string(data))) {
		t.Fatalf("persisted id must satisfy the shared charset rule: %q", string(data))
	}
}

func TestRuntimeHostIDDistinctAcrossRoots(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()

	t.Setenv("FREE4CHAT_AGENT_DIR", dirA)
	idA, err := RuntimeHostID()
	if err != nil {
		t.Fatalf("root A id failed: %v", err)
	}
	t.Setenv("FREE4CHAT_AGENT_DIR", dirB)
	idB, err := RuntimeHostID()
	if err != nil {
		t.Fatalf("root B id failed: %v", err)
	}
	if idA == idB {
		t.Fatalf("distinct Runtime roots must have distinct host ids")
	}
}

func TestRuntimeHostIDRegeneratesMalformedFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A poisoned file must be replaced, never trusted.
	if err := os.WriteFile(filepath.Join(dir, hostIDFile), []byte("bad id with spaces!"), 0o600); err != nil {
		t.Fatal(err)
	}
	id, err := RuntimeHostID()
	if err != nil {
		t.Fatalf("RuntimeHostID after malformed file failed: %v", err)
	}
	if !validRuntimeHostID(id) {
		t.Fatalf("regenerated id must be valid: %q", id)
	}
	if !validRuntimeHostID("deadbeef-1234-5678-9abc-def012345678") ||
		validRuntimeHostID("short") ||
		validRuntimeHostID("has space inside") {
		t.Fatalf("charset rule changed unexpectedly")
	}
}
