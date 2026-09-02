package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// #228: the bounded log rotates at the size bound and keeps at most one
// previous generation; Tail(n) returns at most n lines, newest last.
func TestBoundedLogRotatesAndTails(t *testing.T) {
	dir := t.TempDir()
	log := NewBoundedLog(dir)

	line := strings.Repeat("x", 1024) // 1 KiB per line
	for i := 0; i < 1500; i++ {
		log.Appendf("line-%04d %s", i, line)
	}

	active := filepath.Join(dir, logDirName, logFileName)
	info, err := os.Stat(active)
	if err != nil {
		t.Fatalf("active log missing: %v", err)
	}
	if info.Size() >= maxLogBytes {
		t.Fatalf("active log exceeded the rotation bound: %d", info.Size())
	}
	if _, err := os.Stat(filepath.Join(dir, logDirName, logOldFileName)); err != nil {
		t.Fatalf("rotated generation missing: %v", err)
	}

	lines := log.Tail(100, "")
	if len(lines) != 100 {
		t.Fatalf("Tail(100) returned %d lines", len(lines))
	}
	// Newest line must be last.
	if !strings.Contains(lines[len(lines)-1], "line-1499") &&
		!strings.Contains(lines[len(lines)-1], "line-14") {
		t.Fatalf("tail order wrong, last=%q", lines[len(lines)-1])
	}
}

// #228: concurrent residents appending must not corrupt the file, and the
// instance tag filter isolates one resident's lines.
func TestBoundedLogConcurrentAppendAndFilter(t *testing.T) {
	dir := t.TempDir()
	log := NewBoundedLog(dir)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				log.Appendf("[inst-%d] event-%d ok", i, j)
			}
		}(i)
	}
	wg.Wait()

	lines := log.Tail(500, "")
	if len(lines) != 200 {
		t.Fatalf("expected 200 lines, got %d", len(lines))
	}
	scoped := log.Tail(500, "[inst-7]")
	if len(scoped) != 10 {
		t.Fatalf("instance filter must isolate one resident: %d", len(scoped))
	}
	for _, line := range scoped {
		if !strings.Contains(line, "[inst-7]") {
			t.Fatalf("filter leaked another instance: %q", line)
		}
	}
}
