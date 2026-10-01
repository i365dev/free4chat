//go:build darwin || linux

package daemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ErrDaemonAlreadyRunning means another process owns this RuntimeDirectory.
var ErrDaemonAlreadyRunning = errors.New("another daemon is already running")

// lockDaemon acquires crash-released ownership of one RuntimeDirectory.
func lockDaemon(dir string) (func(), error) {
	file, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("daemon lock open failed: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrDaemonAlreadyRunning
		}
		return nil, fmt.Errorf("daemon lock failed: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}
