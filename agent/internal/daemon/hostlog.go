package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Bounded local daemon log (#228): a small, size-capped, rotating text log
// under the Runtime directory so detached residents keep a post-hoc
// diagnostic history. Lines are caller-provided and already secret-free by
// the Runtime logging contract (no participant handles, tokens, credential
// material, raw SDP, transcript text, or Harness output).
const (
	logFileName    = "daemon.log"
	logOldFileName = "daemon.log.old"
	maxLogBytes    = 1 << 20 // rotate the active file at 1 MiB
	maxLogOldBytes = 1 << 20 // keep at most one previous generation
	logDirName     = "logs"
)

// LogFilePath returns the bounded daemon log location for this Runtime root.
func LogFilePath() string {
	return filepath.Join(RuntimeDirectory(), logDirName, logFileName)
}

// BoundedLog appends timestamped lines to logs/daemon.log, rotating to
// daemon.log.old when the active file exceeds maxLogBytes. Safe for
// concurrent use by all resident runtimes.
type BoundedLog struct {
	mu  sync.Mutex
	dir string
}

// NewBoundedLog creates the bounded log rooted at the Runtime directory.
func NewBoundedLog(dir string) *BoundedLog {
	return &BoundedLog{dir: filepath.Join(dir, logDirName)}
}

// Append writes one pre-formatted line (a trailing newline is added once).
// Failures are silent: diagnostics must never break the daemon.
func (l *BoundedLog) Append(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return
	}
	path := filepath.Join(l.dir, logFileName)
	if info, err := os.Stat(path); err == nil && info.Size() >= maxLogBytes {
		_ = os.Rename(path, filepath.Join(l.dir, logOldFileName))
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprint(f, strings.TrimRight(line, "\n")+"\n")
}

// Appendf writes one formatted, timestamped line.
func (l *BoundedLog) Appendf(format string, args ...any) {
	l.Append(time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...))
}

// Tail returns the last n lines, optionally filtered to lines containing
// filter (empty = all). Older-generation lines come first when present.
func (l *BoundedLog) Tail(n int, filter string) []string {
	if n <= 0 {
		n = 200
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	var lines []string
	oldPath := filepath.Join(l.dir, logOldFileName)
	if data, err := os.ReadFile(oldPath); err == nil {
		lines = append(lines, splitLogLines(data)...)
	}
	if data, err := os.ReadFile(filepath.Join(l.dir, logFileName)); err == nil {
		lines = append(lines, splitLogLines(data)...)
	}
	var filtered []string
	for _, line := range lines {
		if filter == "" || strings.Contains(line, filter) {
			filtered = append(filtered, line)
		}
	}
	if len(filtered) > n {
		filtered = filtered[len(filtered)-n:]
	}
	return filtered
}

func splitLogLines(data []byte) []string {
	parts := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	out := make([]string, 0, len(parts))
	for _, line := range parts {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}
