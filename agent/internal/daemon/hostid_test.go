package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/i365dev/free4chat/agent/internal/types"
)

// #176 Phase A: the private Runtime root seed is stable within one root,
// distinct across roots, persisted 0600, and never machine-derived.
func TestRuntimeHostSeedStableWithinRoot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)

	first, err := RuntimeHostSeed()
	if err != nil {
		t.Fatalf("first RuntimeHostSeed failed: %v", err)
	}
	for i := 0; i < 3; i++ {
		again, err := RuntimeHostSeed()
		if err != nil {
			t.Fatalf("repeat RuntimeHostSeed failed: %v", err)
		}
		if again != first {
			t.Fatalf("seed must be stable within one root: %s vs %s", first, again)
		}
	}

	// Persisted file: 0600, opaque bounded charset only.
	path := filepath.Join(dir, hostSeedFile)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("seed file missing: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("seed file must be 0600, got %v", perm)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("seed file unreadable: %v", err)
	}
	if !types.ValidRuntimeHostID(strings.TrimSpace(string(data))) {
		t.Fatalf("persisted seed must satisfy the shared charset rule: %q", string(data))
	}
}

func TestRuntimeHostSeedDistinctAcrossRoots(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()

	t.Setenv("FREE4CHAT_AGENT_DIR", dirA)
	idA, err := RuntimeHostSeed()
	if err != nil {
		t.Fatalf("root A seed failed: %v", err)
	}
	t.Setenv("FREE4CHAT_AGENT_DIR", dirB)
	idB, err := RuntimeHostSeed()
	if err != nil {
		t.Fatalf("root B seed failed: %v", err)
	}
	if idA == idB {
		t.Fatalf("distinct Runtime roots must have distinct seeds")
	}
}

func TestRuntimeHostSeedRegeneratesMalformedFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A poisoned file must be replaced, never trusted.
	if err := os.WriteFile(filepath.Join(dir, hostSeedFile), []byte("bad seed with spaces!"), 0o600); err != nil {
		t.Fatal(err)
	}
	seed, err := RuntimeHostSeed()
	if err != nil {
		t.Fatalf("RuntimeHostSeed after malformed file failed: %v", err)
	}
	if !types.ValidRuntimeHostID(seed) {
		t.Fatalf("regenerated seed must be valid: %q", seed)
	}
}

// #178 review fix 1: first-use initialization must be atomic and no-clobber.
// 50 concurrent first-callers on one fresh root must all observe exactly ONE
// seed, and the published file must always be complete (never the empty
// O_EXCL artifact the previous implementation could expose).
func TestRuntimeHostSeedConcurrentInitializationYieldsOneSeed(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dir)

	const goroutines = 50
	results := make([]string, goroutines)
	errs := make([]error, goroutines)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // release all racers at once
			results[i], errs[i] = RuntimeHostSeed()
		}(i)
	}
	close(start)
	wg.Wait()

	seen := map[string]int{}
	for i := 0; i < goroutines; i++ {
		if errs[i] != nil {
			t.Fatalf("concurrent caller %d failed: %v", i, errs[i])
		}
		if results[i] == "" {
			t.Fatalf("concurrent caller %d observed an empty seed", i)
		}
		if !types.ValidRuntimeHostID(results[i]) {
			t.Fatalf("concurrent caller %d observed a malformed seed: %q", i, results[i])
		}
		seen[results[i]]++
	}
	if len(seen) != 1 {
		t.Fatalf("all %d concurrent callers must agree on ONE seed, saw %d distinct: %v",
			goroutines, len(seen), seen)
	}
	// The published file is the agreed seed, complete and 0600.
	data, err := os.ReadFile(filepath.Join(dir, hostSeedFile))
	if err != nil {
		t.Fatalf("seed file unreadable: %v", err)
	}
	if strings.TrimSpace(string(data)) != results[0] {
		t.Fatalf("published seed mismatch: %q vs %q", strings.TrimSpace(string(data)), results[0])
	}
	info, err := os.Stat(filepath.Join(dir, hostSeedFile))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("seed file must be 0600, got %v", perm)
	}
}

// #178 review fix 3: the public runtimeHostId is DERIVED per Room from the
// private root seed — never the raw seed; same root + same Room is stable,
// different Rooms (one root) and different roots (one Room) diverge, and
// derivation fails closed without a final non-empty roomId (create-first
// derives AFTER the room id exists).
func TestDeriveRuntimeHostIDRoomScoped(t *testing.T) {
	dirA := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dirA)
	seedA, err := RuntimeHostSeed()
	if err != nil {
		t.Fatal(err)
	}
	dirB := t.TempDir()
	t.Setenv("FREE4CHAT_AGENT_DIR", dirB)
	seedB, err := RuntimeHostSeed()
	if err != nil {
		t.Fatal(err)
	}
	room1 := "11111111-1111-1111-1111-111111111111"
	room2 := "22222222-2222-2222-2222-222222222222"

	id1a, err := types.DeriveRuntimeHostID(seedA, room1)
	if err != nil {
		t.Fatalf("derive failed: %v", err)
	}
	// Same root + same Room: deterministic and stable.
	again, err := types.DeriveRuntimeHostID(seedA, room1)
	if err != nil || again != id1a {
		t.Fatalf("derivation must be deterministic: %s vs %s (%v)", id1a, again, err)
	}
	// Never the raw seed.
	if id1a == seedA {
		t.Fatal("derived id must never equal the raw root seed")
	}
	// Different Room, same root: diverges (no cross-Room correlation).
	id2a, err := types.DeriveRuntimeHostID(seedA, room2)
	if err != nil || id2a == id1a {
		t.Fatalf("different Rooms on one root must derive different ids: %s vs %s", id1a, id2a)
	}
	// Different root, same Room: diverges.
	id1b, err := types.DeriveRuntimeHostID(seedB, room1)
	if err != nil || id1b == id1a {
		t.Fatalf("different roots on one Room must derive different ids: %s vs %s", id1a, id1b)
	}
	// Derived ids satisfy the shared wire rule.
	if !types.ValidRuntimeHostID(id1a) || len(id1a) > 64 {
		t.Fatalf("derived id must satisfy the wire charset rule: %q", id1a)
	}
	// Fail closed without a final roomId.
	if _, err := types.DeriveRuntimeHostID(seedA, ""); err == nil {
		t.Fatal("empty roomId must fail closed")
	}
}
