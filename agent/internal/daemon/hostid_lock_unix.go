//go:build !windows

package daemon

import (
	"os"
	"path/filepath"
	"syscall"
)

// lockHostSeed serializes the seed read-evaluate-publish sequence across
// processes AND goroutines (#178 review fix 2) via an exclusive flock on a
// dedicated content-free lock file inside the Runtime directory. Callers
// block until the lock is available; the critical section is tiny.
func lockHostSeed(dir string) (func(), error) {
	path := filepath.Join(dir, "host-seed.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		_ = f.Close()
		return nil, err
	}
	release := func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}
	return release, nil
}
